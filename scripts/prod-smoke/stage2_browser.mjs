#!/usr/bin/env node
/**
 * Reusable Stage-2 silent headless Chrome smoke & acceptance tool for DokiTool-Go.
 *
 * Hard constraints:
 * - Zero third-party dependencies (Node 22/24 standard library + ../download-browser-session.mjs).
 * - Mandatory silent headless mode (--headless=new --no-first-run --no-default-browser-check
 *   --use-mock-keychain --password-store=basic); never opens a visible window or steals focus.
 * - Guaranteed teardown of all spawned Chrome child process groups and temp directories in
 *   finally / signal handlers, plus post-cleanup residual process verification.
 * - Zero hardcoded machine paths, Playwright revision numbers, or fixed proxy ports.
 * - Read-only by default; optional --sync-local-extension writes atomically ONLY after archive
 *   verification passes and ONLY to paths confirmed untracked by Git.
 * - Fail-closed output redaction scanner aligned with scripts/prod-smoke/smoke.py.
 */

import { execFileSync, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";
import { connect, connectPipe, until } from "../download-browser-session.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_META_PATH = path.resolve(
  SCRIPT_DIR,
  "..",
  "..",
  "frontend",
  "src",
  "core",
  "extensionReleaseMeta.json",
);
let REPO_EXTENSION_ID = "ihamkldlkdibleacagiejklpfofapkpo";
try {
  if (fs.existsSync(EXTENSION_META_PATH)) {
    const meta = JSON.parse(fs.readFileSync(EXTENSION_META_PATH, "utf8"));
    if (typeof meta?.extensionId === "string" && /^[a-p]{32}$/.test(meta.extensionId)) {
      REPO_EXTENSION_ID = meta.extensionId;
    }
  }
} catch {
  // fallback to pinned ID when run outside repo checkout
}

export const SCHEMA_VERSION = "1.0";
export const DEFAULT_BASE_URL = "https://snap.dokitool.com";
export const DEFAULT_PROFILE = "lite";
export const VALID_PROFILES = Object.freeze(["lite", "full"]);
export const DEFAULT_TIMEOUT_SECONDS = 30;
export const DEFAULT_PARSE_PACING_MS = 8500;
export const DOKITOOL_EXTENSION_ID = REPO_EXTENSION_ID;
export const EXPECTED_BRIDGE_CAPABILITIES = Object.freeze([
  "dash_mux",
  "direct_download",
  "youtube_parse",
  "youtube_mux",
]);

export const MANDATORY_HEADLESS_FLAGS = Object.freeze([
  "--headless=new",
  "--no-first-run",
  "--no-default-browser-check",
  "--use-mock-keychain",
  "--password-store=basic",
]);

export const ALLOWED_EXTENSION_PERMISSIONS = Object.freeze([
  "sidePanel",
  "offscreen",
  "downloads",
  "storage",
  "contextMenus",
  "tabs",
  "declarativeNetRequestWithHostAccess",
]);

export const FORBIDDEN_EXTENSION_PERMISSIONS = Object.freeze([
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

const REQUIRED_EXTENSION_FILES = Object.freeze([
  "manifest.json",
  "background.js",
  "sidepanel.html",
  "offscreen.html",
  "icons/icon-16.png",
  "icons/icon-32.png",
  "icons/icon-48.png",
  "icons/icon-128.png",
]);

const FORBIDDEN_REQUEST_HEADERS = new Set([
  "authorization",
  "cookie",
  "proxy-authorization",
  "set-cookie",
  "x-dokitool-client-ip",
  "x-dokitool-edge-key",
  "x-dokitool-token",
]);

const MAX_HTTP_BODY_BYTES = 16 * 1024 * 1024;
const MAX_ZIP_ENTRY_BYTES = 32 * 1024 * 1024;
const MAX_ZIP_TOTAL_BYTES = 64 * 1024 * 1024;

export const DEFAULT_SAMPLES_PATH = path.join(SCRIPT_DIR, "samples.json");

const URL_RE = /\b(?:https?|wss?|file|ftp):\/\/[^\s"'<>`|]+/gi;
const SENSITIVE_TOKEN_RE =
  /\b(?:xsec_token|xsec_source|owner_token|access_token|auth_key|hdnts)(?:\s*[=:]\s*[^\s&"'<>`,;|)]+)?/gi;
const BEARER_TOKEN_RE = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const TICKET_KV_RE = /\bticket\s*[=:]\s*[^\s&"'<>`,;|)]+/gi;
const SIGNATURE_KV_RE =
  /\b(?:sign|signature|sig|token|key|expires)\s*[=:]\s*[^\s&"'<>`,;|)]+/gi;
const RELAY_PATH_RE = /\/api\/media\/(?:<relay-redacted>|[^\s"'<>`|]*)/gi;
const QUERY_STRING_RE = /\?[A-Za-z0-9_%\-=&.+~:/]+/g;
const IPV4_CANDIDATE_RE =
  /(?<![0-9A-Za-z.])(?:\d{1,3}\.){3}\d{1,3}(?![0-9A-Za-z.])/g;
const IPV6_CANDIDATE_RE =
  /\[?(?<![0-9A-Za-z:])(?:[0-9A-Fa-f]{0,4}:){2,7}[0-9A-Fa-f]{0,4}(?![0-9A-Za-z:])\]?/g;
const UNIX_HOME_PATH_RE =
  /(?:\/Users\/|\/home\/|\/private\/var\/folders\/)[^\s"'<>`|)]+/g;
const WIN_HOME_PATH_RE = /[A-Za-z]:(?:\\{1,2}|\/)Users(?:\\{1,2}|\/)[^\s"'<>`|)]+/gi;
const UUID_36_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class Stage2Error extends Error {
  constructor(message) {
    super(message);
    this.name = "Stage2Error";
  }
}

export class RedactionViolationError extends Stage2Error {
  constructor(message) {
    super(message);
    this.name = "RedactionViolationError";
  }
}

// ============================================================================
// IP, Hostname, URL, Proxy Validation & Redaction
// ============================================================================

export function isIpLiteral(value) {
  let candidate = String(value || "").trim();
  if (candidate.startsWith("[") && candidate.endsWith("]")) {
    candidate = candidate.slice(1, -1);
  }
  const zoneIdx = candidate.indexOf("%");
  if (zoneIdx >= 0) {
    candidate = candidate.slice(0, zoneIdx);
  }
  if (!candidate) return false;
  return net.isIP(candidate) !== 0;
}

export function isLoopbackHost(rawHost) {
  let host = String(rawHost || "").trim().toLowerCase().replace(/\.+$/, "");
  if (host.startsWith("[") && host.endsWith("]")) {
    host = host.slice(1, -1);
  }
  if (!host) return false;
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (net.isIPv4(host)) {
    return host.startsWith("127.");
  }
  if (net.isIPv6(host)) {
    const normalized = host.toLowerCase();
    return (
      normalized === "::1" ||
      normalized === "0:0:0:0:0:0:0:1" ||
      normalized.startsWith("::ffff:127.")
    );
  }
  return false;
}

export function sanitizeHostname(rawHost) {
  let host = String(rawHost || "").trim().toLowerCase().replace(/\.+$/, "");
  if (host.startsWith("[") && host.endsWith("]")) {
    host = host.slice(1, -1);
  }
  if (!host) return "";
  if (isIpLiteral(host)) return "<ip-redacted>";
  for (const sep of ["/", "?", "#", "@", ":"]) {
    const idx = host.indexOf(sep);
    if (idx >= 0) host = host.slice(0, idx);
  }
  if (!host || isIpLiteral(host)) return "<ip-redacted>";
  return sanitizeText(host);
}

function replaceIpCandidates(text) {
  let out = text.replace(IPV4_CANDIDATE_RE, (token) =>
    net.isIPv4(token) ? "<ip-redacted>" : token,
  );
  out = out.replace(IPV6_CANDIDATE_RE, (token) => {
    const inner =
      token.startsWith("[") && token.endsWith("]")
        ? token.slice(1, -1)
        : token;
    return isIpLiteral(inner) ? "<ip-redacted>" : token;
  });
  return out;
}

export function sanitizeText(value) {
  if (value === null || value === undefined) return "";
  let out = String(value);
  if (!out) return "";
  out = out.replace(URL_RE, "<url-redacted>");
  out = out.replace(RELAY_PATH_RE, "/api/media/<relay-redacted>");
  out = out.replace(BEARER_TOKEN_RE, "<auth-redacted>");
  out = out.replace(/\bBearer\b/gi, "<auth-redacted>");
  out = out.replace(SENSITIVE_TOKEN_RE, "<token-redacted>");
  out = out.replace(TICKET_KV_RE, "<ticket-redacted>");
  out = out.replace(SIGNATURE_KV_RE, "<sig-redacted>");
  out = out.replace(QUERY_STRING_RE, "?<query-redacted>");
  out = out.replace(UNIX_HOME_PATH_RE, "<path-redacted>");
  out = out.replace(WIN_HOME_PATH_RE, "<path-redacted>");
  const homeDir = os.homedir();
  if (homeDir && homeDir.length >= 4 && out.includes(homeDir)) {
    out = out.split(homeDir).join("<home-redacted>");
  }
  out = replaceIpCandidates(out);
  return out.replace(/\s+/g, " ").trim();
}

export function scanSensitiveOutput(rendered, options = {}) {
  const text = String(rendered || "");
  const violations = [];
  const homeDir =
    options.homeDir !== undefined ? String(options.homeDir) : os.homedir();

  if (new RegExp(URL_RE.source, "i").test(text)) {
    violations.push("unredacted URL detected in output");
  }
  if (
    /\b(?:xsec_token|xsec_source|owner_token|access_token|auth_key|hdnts)\b/i.test(
      text,
    )
  ) {
    violations.push("unredacted token identifier detected in output");
  }
  if (/\bBearer\b/i.test(text)) {
    violations.push("unredacted Bearer authorization marker detected in output");
  }
  if (/\bticket\s*[=:]/i.test(text)) {
    violations.push("unredacted relay ticket detected in output");
  }
  if (/\b(?:sign|signature|sig)\s*[=:]/i.test(text)) {
    violations.push("unredacted signature parameter detected in output");
  }
  for (const match of text.matchAll(RELAY_PATH_RE)) {
    if (match[0] !== "/api/media/<relay-redacted>") {
      violations.push("unredacted media relay path detected in output");
      break;
    }
  }
  for (const match of text.matchAll(QUERY_STRING_RE)) {
    if (match[0] !== "?<query-redacted>") {
      violations.push("unredacted query string detected in output");
      break;
    }
  }
  for (const match of text.matchAll(IPV4_CANDIDATE_RE)) {
    if (net.isIPv4(match[0])) {
      violations.push("unredacted IPv4 address detected in output");
      break;
    }
  }
  for (const match of text.matchAll(IPV6_CANDIDATE_RE)) {
    const token = match[0];
    const inner =
      token.startsWith("[") && token.endsWith("]")
        ? token.slice(1, -1)
        : token;
    if (isIpLiteral(inner)) {
      violations.push("unredacted IPv6 address detected in output");
      break;
    }
  }
  if (
    new RegExp(UNIX_HOME_PATH_RE.source).test(text) ||
    new RegExp(WIN_HOME_PATH_RE.source, "i").test(text)
  ) {
    violations.push("unredacted local machine path detected in output");
  }
  if (homeDir && homeDir.length >= 4) {
    const jsonEscapedHome = JSON.stringify(homeDir).slice(1, -1);
    if (text.includes(homeDir) || (jsonEscapedHome && text.includes(jsonEscapedHome))) {
      violations.push("unredacted home directory path detected in output");
    }
  }

  return violations;
}

export function verifyRedactedOutput(rendered, options = {}) {
  const violations = scanSensitiveOutput(rendered, options);
  if (violations.length > 0) {
    throw new RedactionViolationError(violations.join("; "));
  }
}

export function validateBaseUrl(rawBaseUrl) {
  const raw = String(rawBaseUrl || "").trim();
  if (!raw) {
    throw new Stage2Error("invalid --base-url: value is required");
  }
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Stage2Error(
      "invalid --base-url: expected https://<host>[:port] or http://<loopback>[:port]",
    );
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new Stage2Error("invalid --base-url: credentials in URL are forbidden");
  }
  // Reject bare userinfo such as https://@host or https://user:@host.
  const schemeEnd = raw.indexOf("://");
  if (schemeEnd >= 0) {
    const rest = raw.slice(schemeEnd + 3);
    const authority = rest.split(/[/?#]/, 1)[0];
    if (authority.includes("@")) {
      throw new Stage2Error(
        "invalid --base-url: credentials in URL are forbidden",
      );
    }
  }
  if (!parsed.hostname) {
    throw new Stage2Error("invalid --base-url: hostname is required");
  }
  if (parsed.search || parsed.hash) {
    throw new Stage2Error(
      "invalid --base-url: query and fragment are forbidden",
    );
  }
  if (parsed.pathname !== "" && parsed.pathname !== "/") {
    throw new Stage2Error("invalid --base-url: base path must be root '/'");
  }
  const loopback = isLoopbackHost(parsed.hostname);
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) {
    throw new Stage2Error(
      "invalid --base-url: use https:// for remote origins (http:// allowed only for loopback)",
    );
  }
  const port = parsed.port
    ? Number(parsed.port)
    : parsed.protocol === "https:"
      ? 443
      : 80;
  return {
    origin: parsed.origin,
    protocol: parsed.protocol,
    hostname: parsed.hostname,
    port,
    isLoopback: loopback,
    targetHost: sanitizeHostname(parsed.hostname),
  };
}

export function hostMatchesNoProxy(targetHost, targetPort, noProxyRaw) {
  const raw = String(noProxyRaw || "").trim();
  if (!raw) return false;
  const host = String(targetHost || "").trim().toLowerCase().replace(/^\[|\]$/g, "");
  for (const part of raw.split(",")) {
    const token = part.trim().toLowerCase();
    if (!token) continue;
    if (token === "*") return true;
    let entryHost = token;
    let entryPort = null;
    if (entryHost.startsWith("[")) {
      const endBracket = entryHost.indexOf("]");
      if (endBracket > 0) {
        const after = entryHost.slice(endBracket + 1);
        if (after.startsWith(":")) entryPort = Number(after.slice(1));
        entryHost = entryHost.slice(1, endBracket);
      }
    } else {
      const colonCount = (entryHost.match(/:/g) || []).length;
      if (colonCount === 1) {
        const [h, p] = entryHost.split(":");
        entryHost = h;
        entryPort = Number(p);
      }
    }
    if (entryPort !== null && Number.isFinite(entryPort) && entryPort !== targetPort) {
      continue;
    }
    const cleanEntry = entryHost.replace(/^\.+/, "");
    if (!cleanEntry) continue;
    if (host === cleanEntry || host.endsWith("." + cleanEntry)) {
      return true;
    }
  }
  return false;
}

export function validateProxyUrl(rawProxy, sourceLabel = "--proxy") {
  let candidate = String(rawProxy || "").trim();
  if (!candidate) return null;
  if (!candidate.includes("://")) {
    candidate = "http://" + candidate;
  }
  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Stage2Error(`invalid ${sourceLabel}: malformed proxy URL`);
  }
  const schemeEnd = candidate.indexOf("://");
  const authority = candidate.slice(schemeEnd + 3).split(/[/?#]/, 1)[0];
  if (parsed.username !== "" || parsed.password !== "" || authority.includes("@")) {
    throw new Stage2Error(`invalid ${sourceLabel}: proxy credentials are forbidden`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Stage2Error(
      `invalid ${sourceLabel}: only http:// or https:// proxy URLs are supported`,
    );
  }
  if (!parsed.hostname) {
    throw new Stage2Error(`invalid ${sourceLabel}: proxy hostname is required`);
  }
  if (parsed.search || parsed.hash || (parsed.pathname !== "" && parsed.pathname !== "/")) {
    throw new Stage2Error(
      `invalid ${sourceLabel}: proxy URL must not include path, query, or fragment`,
    );
  }
  const port = parsed.port
    ? Number(parsed.port)
    : parsed.protocol === "https:"
      ? 443
      : 80;
  return {
    origin: parsed.origin,
    protocol: parsed.protocol,
    hostname: parsed.hostname,
    port,
  };
}

export function resolveProxyConfig({ cliProxy = "", env = process.env, target }) {
  const noProxyRaw = env.NO_PROXY || env.no_proxy || "";
  // Always validate explicit --proxy first (fail-closed on credentials even for loopback).
  const parsedCli = cliProxy ? validateProxyUrl(cliProxy, "--proxy") : null;

  if (target.isLoopback) {
    return {
      proxy: null,
      mode: "direct",
      bypassList: "localhost;127.0.0.1;[::1]",
      forceNoProxy: true,
    };
  }

  if (parsedCli) {
    if (hostMatchesNoProxy(target.hostname, target.port, noProxyRaw)) {
      return {
        proxy: null,
        mode: "direct",
        bypassList: buildChromeBypassList(noProxyRaw),
        forceNoProxy: true,
      };
    }
    return {
      proxy: parsedCli,
      mode: "cli-proxy",
      bypassList: buildChromeBypassList(noProxyRaw),
      forceNoProxy: false,
    };
  }

  const rawEnvProxy =
    target.protocol === "https:"
      ? env.HTTPS_PROXY || env.https_proxy || ""
      : env.HTTP_PROXY || env.http_proxy || "";

  if (!rawEnvProxy.trim()) {
    return {
      proxy: null,
      mode: "direct",
      bypassList: buildChromeBypassList(noProxyRaw),
      forceNoProxy: false,
    };
  }

  // Always reject credentials in environment proxy URLs.
  const parsedEnv = validateProxyUrl(rawEnvProxy, "environment proxy");
  if (hostMatchesNoProxy(target.hostname, target.port, noProxyRaw)) {
    return {
      proxy: null,
      mode: "direct",
      bypassList: buildChromeBypassList(noProxyRaw),
      forceNoProxy: true,
    };
  }

  return {
    proxy: parsedEnv,
    mode: "env-proxy",
    bypassList: buildChromeBypassList(noProxyRaw),
    forceNoProxy: false,
  };
}

function buildChromeBypassList(noProxyRaw) {
  const items = new Set(["localhost", "127.0.0.1", "[::1]"]);
  for (const part of String(noProxyRaw || "").split(",")) {
    const trimmed = part.trim();
    if (trimmed && !trimmed.includes(";") && !/\s/.test(trimmed)) {
      items.add(trimmed);
    }
  }
  return Array.from(items).join(";");
}

// ============================================================================
// Chrome Auto-Discovery (zero hardcoded machine paths or revision numbers)
// ============================================================================

function isExecutableFile(
  candidatePath,
  existsSync = fs.existsSync,
  statSync = fs.statSync,
  accessSync = fs.accessSync,
) {
  try {
    if (!candidatePath || !existsSync(candidatePath)) return false;
    const st = statSync(candidatePath);
    if (!st.isFile()) return false;
    if (process.platform !== "win32") {
      accessSync(candidatePath, fs.constants.X_OK);
    }
    return true;
  } catch {
    return false;
  }
}

export function discoverChromeBinary(options = {}) {
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const arch = options.arch || process.arch;
  const homeDir = options.homeDir || os.homedir();
  const exists = options.existsSync || fs.existsSync;
  const readdir = options.readdirSync || fs.readdirSync;
  const stat = options.statSync || fs.statSync;
  const access = options.accessSync || fs.accessSync;
  const isExec =
    options.isExecutable ||
    ((p) => isExecutableFile(p, exists, stat, access));

  if (options.cliChromeBin) {
    const resolved = path.resolve(options.cliChromeBin);
    if (!isExec(resolved)) {
      throw new Stage2Error("invalid --chrome-bin: executable not found");
    }
    return { path: resolved, source: "cli" };
  }

  if (env.DOKITOOL_CHROME_BIN && String(env.DOKITOOL_CHROME_BIN).trim()) {
    const resolved = path.resolve(String(env.DOKITOOL_CHROME_BIN).trim());
    if (!isExec(resolved)) {
      throw new Stage2Error(
        "invalid DOKITOOL_CHROME_BIN: executable not found",
      );
    }
    return { path: resolved, source: "env" };
  }

  // 1. Playwright cache auto-discovery (prefer latest chromium-<rev> Chrome for Testing)
  const playwrightRoots = [];
  if (
    env.PLAYWRIGHT_BROWSERS_PATH &&
    env.PLAYWRIGHT_BROWSERS_PATH !== "0" &&
    String(env.PLAYWRIGHT_BROWSERS_PATH).trim()
  ) {
    playwrightRoots.push(String(env.PLAYWRIGHT_BROWSERS_PATH).trim());
  }
  if (platform === "darwin") {
    playwrightRoots.push(path.join(homeDir, "Library", "Caches", "ms-playwright"));
  } else if (platform === "win32") {
    const localAppData = env.LOCALAPPDATA || path.join(homeDir, "AppData", "Local");
    playwrightRoots.push(path.join(localAppData, "ms-playwright"));
  } else {
    const xdgCache = env.XDG_CACHE_HOME || path.join(homeDir, ".cache");
    playwrightRoots.push(path.join(xdgCache, "ms-playwright"));
  }

  const macSubpaths =
    arch === "arm64"
      ? [
          "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
          "chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
          "chrome-mac/Chromium.app/Contents/MacOS/Chromium",
        ]
      : [
          "chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
          "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
          "chrome-mac/Chromium.app/Contents/MacOS/Chromium",
        ];

  const platformSubpaths =
    platform === "darwin"
      ? macSubpaths
      : platform === "win32"
        ? ["chrome-win64/chrome.exe", "chrome-win/chrome.exe"]
        : ["chrome-linux64/chrome", "chrome-linux/chrome"];

  for (const root of playwrightRoots) {
    if (!exists(root)) continue;
    let entries;
    try {
      entries = readdir(root);
    } catch {
      continue;
    }
    const revisions = entries
      .map((name) => {
        const m = /^chromium-(\d+)$/.exec(String(name));
        return m ? { name: String(name), rev: Number(m[1]) } : null;
      })
      .filter(Boolean)
      .sort((a, b) => b.rev - a.rev);

    for (const item of revisions) {
      for (const rel of platformSubpaths) {
        const candidate = path.join(root, item.name, ...rel.split("/"));
        if (isExec(candidate)) {
          return {
            path: candidate,
            source: "playwright-cache",
            revision: item.rev,
          };
        }
      }
    }
  }

  // 2. System Chrome / Chromium fallbacks
  const systemCandidates = [];
  if (platform === "darwin") {
    systemCandidates.push(
      "/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
    );
  } else if (platform === "win32") {
    const roots = [
      env.PROGRAMFILES,
      env["PROGRAMFILES(X86)"],
      env.LOCALAPPDATA,
    ].filter(Boolean);
    for (const base of roots) {
      systemCandidates.push(
        path.join(base, "Google", "Chrome", "Application", "chrome.exe"),
      );
    }
  } else {
    const pathDirs = String(env.PATH || "/usr/bin:/usr/local/bin")
      .split(path.delimiter)
      .filter(Boolean);
    for (const binName of [
      "google-chrome",
      "google-chrome-stable",
      "chromium",
      "chromium-browser",
    ]) {
      for (const dir of pathDirs) {
        systemCandidates.push(path.join(dir, binName));
      }
    }
  }

  for (const candidate of systemCandidates) {
    if (isExec(candidate)) {
      return { path: candidate, source: "system" };
    }
  }

  return null;
}

// ============================================================================
// Origin-Locked Zero-Dep HTTP/HTTPS Client (with CONNECT proxy & raw headers)
// ============================================================================

export class OriginHttpClient {
  constructor({ target, proxyConfig, timeoutMs = DEFAULT_TIMEOUT_SECONDS * 1000 }) {
    this.target = target;
    this.proxyConfig = proxyConfig;
    this.timeoutMs = Math.max(1000, Number(timeoutMs) || 30_000);
    // Dedicated non-keepAlive agents prevent idle sockets from pinning Node's event loop after runStage2 returns.
    this._httpAgent = new http.Agent({ keepAlive: false });
    this._httpsAgent = new https.Agent({ keepAlive: false });
    this._activeSockets = new Set();
  }

  close() {
    this._httpAgent.destroy();
    this._httpsAgent.destroy();
    for (const sock of this._activeSockets) {
      try {
        sock.destroy();
      } catch {
        // ignore
      }
    }
    this._activeSockets.clear();
  }

  async get(pathAndQuery, options = {}) {
    if (typeof pathAndQuery !== "string" || !pathAndQuery.startsWith("/")) {
      throw new Stage2Error("request path must start with '/'");
    }
    if (pathAndQuery.startsWith("//")) {
      throw new Stage2Error("protocol-relative paths are forbidden");
    }
    if (/[\r\n\0]/.test(pathAndQuery)) {
      throw new Stage2Error("control characters in request path are forbidden");
    }
    const pathOnly = pathAndQuery.split("?", 1)[0];
    if (pathOnly.startsWith("/api/media")) {
      throw new Stage2Error("fetching media relay endpoints is forbidden");
    }

    const parsedFull = new URL(pathAndQuery, this.target.origin);
    if (parsedFull.origin !== this.target.origin) {
      throw new Stage2Error("cross-origin request blocked by origin lock");
    }

    const headers = {
      Accept: options.accept || "*/*",
      "Accept-Encoding": options.acceptEncoding || "identity",
      "Cache-Control": "no-cache",
      Connection: "close",
      "User-Agent": "DokiTool-Stage2BrowserSmoke/1.0",
      ...(options.headers || {}),
    };
    for (const name of Object.keys(headers)) {
      const lower = name.toLowerCase();
      if (FORBIDDEN_REQUEST_HEADERS.has(lower) || lower.includes("token")) {
        throw new Stage2Error(`forbidden credential header blocked: ${name}`);
      }
    }

    const startedAt = Date.now();
    const proxy = this.proxyConfig?.proxy || null;

    if (this.target.protocol === "https:" && proxy) {
      return this.#httpsViaProxy(pathAndQuery, headers, proxy, startedAt);
    }
    if (this.target.protocol === "http:" && proxy) {
      return this.#httpViaProxy(parsedFull.href, headers, proxy, startedAt);
    }
    return this.#directRequest(pathAndQuery, headers, startedAt);
  }

  #directRequest(pathAndQuery, headers, startedAt) {
    const isHttps = this.target.protocol === "https:";
    const mod = isHttps ? https : http;
    return new Promise((resolve, reject) => {
      const req = mod.request(
        {
          protocol: this.target.protocol,
          hostname: this.target.hostname,
          port: this.target.port,
          method: "GET",
          path: pathAndQuery,
          headers,
          agent: isHttps ? this._httpsAgent : this._httpAgent,
          timeout: this.timeoutMs,
          ...(isHttps
            ? { servername: this.target.hostname, rejectUnauthorized: true }
            : {}),
        },
        (res) => this.#collectResponse(res, startedAt, resolve, reject),
      );
      req.on("timeout", () => {
        req.destroy(new Error(`HTTP request timed out (${this.timeoutMs}ms)`));
      });
      req.on("error", reject);
      req.end();
    });
  }

  #httpViaProxy(fullHref, headers, proxy, startedAt) {
    const isHttpsProxy = proxy.protocol === "https:";
    const mod = isHttpsProxy ? https : http;
    return new Promise((resolve, reject) => {
      const req = mod.request(
        {
          protocol: proxy.protocol,
          hostname: proxy.hostname,
          port: proxy.port,
          method: "GET",
          path: fullHref,
          headers: { ...headers, Host: new URL(this.target.origin).host },
          agent: isHttpsProxy ? this._httpsAgent : this._httpAgent,
          timeout: this.timeoutMs,
        },
        (res) => this.#collectResponse(res, startedAt, resolve, reject),
      );
      req.on("timeout", () => {
        req.destroy(new Error(`Proxy HTTP request timed out (${this.timeoutMs}ms)`));
      });
      req.on("error", reject);
      req.end();
    });
  }

  #httpsViaProxy(pathAndQuery, headers, proxy, startedAt) {
    return new Promise((resolve, reject) => {
      const isHttpsProxy = proxy.protocol === "https:";
      const proxyMod = isHttpsProxy ? https : http;
      const authority = `${this.target.hostname}:${this.target.port}`;
      let settled = false;
      let rawSocket = null;
      let tlsSocket = null;
      const teardownSockets = () => {
        if (tlsSocket) {
          this._activeSockets.delete(tlsSocket);
          try {
            tlsSocket.destroy();
          } catch {
            // ignore
          }
          tlsSocket = null;
        }
        if (rawSocket) {
          this._activeSockets.delete(rawSocket);
          try {
            rawSocket.destroy();
          } catch {
            // ignore
          }
          rawSocket = null;
        }
      };
      const fail = (err) => {
        if (settled) return;
        settled = true;
        teardownSockets();
        reject(err);
      };
      const done = (val) => {
        if (settled) return;
        settled = true;
        teardownSockets();
        resolve(val);
      };

      const connectReq = proxyMod.request({
        protocol: proxy.protocol,
        hostname: proxy.hostname,
        port: proxy.port,
        method: "CONNECT",
        path: authority,
        headers: { Host: authority },
        agent: isHttpsProxy ? this._httpsAgent : this._httpAgent,
        timeout: this.timeoutMs,
      });

      connectReq.on("timeout", () => {
        connectReq.destroy(new Error("Proxy CONNECT timed out"));
      });
      connectReq.on("error", fail);
      connectReq.on("connect", (proxyRes, socket, head) => {
        rawSocket = socket;
        this._activeSockets.add(socket);
        if (proxyRes.statusCode !== 200) {
          fail(new Error(`Proxy CONNECT rejected with HTTP ${proxyRes.statusCode}`));
          return;
        }
        if (head && head.length > 0) {
          socket.unshift(head);
        }
        tlsSocket = tls.connect({
          socket,
          servername: this.target.hostname,
          rejectUnauthorized: true,
        });
        this._activeSockets.add(tlsSocket);
        tlsSocket.on("error", fail);
        const req = https.request(
          {
            hostname: this.target.hostname,
            port: this.target.port,
            method: "GET",
            path: pathAndQuery,
            headers: { ...headers, Connection: "close" },
            createConnection: () => tlsSocket,
            agent: false,
            timeout: this.timeoutMs,
          },
          (res) => this.#collectResponse(res, startedAt, done, fail),
        );
        req.on("timeout", () => {
          req.destroy(new Error(`HTTPS tunnel request timed out (${this.timeoutMs}ms)`));
        });
        req.on("error", fail);
        req.end();
      });
      connectReq.end();
    });
  }

  #collectResponse(res, startedAt, resolve, reject) {
    const chunks = [];
    let total = 0;
    res.on("data", (chunk) => {
      total += chunk.length;
      if (total > MAX_HTTP_BODY_BYTES) {
        res.destroy(new Error("Response exceeds 16 MiB inspection limit"));
        return;
      }
      chunks.push(chunk);
    });
    res.on("error", reject);
    res.on("end", () => {
      const headerLists = {};
      for (let i = 0; i < res.rawHeaders.length; i += 2) {
        const key = String(res.rawHeaders[i]).toLowerCase();
        const val = String(res.rawHeaders[i + 1]);
        if (!headerLists[key]) headerLists[key] = [];
        headerLists[key].push(val);
      }
      const headers = {};
      for (const [k, vals] of Object.entries(headerLists)) {
        headers[k] = vals.join(", ");
      }
      resolve({
        status: Number(res.statusCode || 0),
        headers,
        headerLists,
        body: Buffer.concat(chunks),
        elapsedMs: Math.max(0, Date.now() - startedAt),
      });
    });
  }
}

// ============================================================================
// Zero-Dep PKZIP 2.0 Parser, Extension Validator & Atomic Untracked Sync
// ============================================================================

export function deriveExtensionIdFromManifestKey(keyBase64) {
  if (typeof keyBase64 !== "string" || !keyBase64.trim()) {
    throw new Stage2Error("manifest.key must be a non-empty base64 string");
  }
  const normalized = keyBase64.replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/]+=*$/.test(normalized)) {
    throw new Stage2Error("manifest.key is not valid base64");
  }
  const der = Buffer.from(normalized, "base64");
  if (der.length === 0) {
    throw new Stage2Error("manifest.key decoded to empty bytes");
  }
  const hexPrefix = crypto
    .createHash("sha256")
    .update(der)
    .digest("hex")
    .slice(0, 32);
  return Array.from(hexPrefix, (ch) =>
    String.fromCharCode(97 + Number.parseInt(ch, 16)),
  ).join("");
}

function compareSemver(a, b) {
  const pa = String(a || "").split(".").map((n) => Number.parseInt(n, 10));
  const pb = String(b || "").split(".").map((n) => Number.parseInt(n, 10));
  if (pa.length !== 3 || pb.length !== 3 || pa.some(Number.isNaN) || pb.some(Number.isNaN)) {
    return 0;
  }
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] > pb[i] ? 1 : -1;
  }
  return 0;
}

function normalizeZipEntryPath(rawPath) {
  if (typeof rawPath !== "string" || !rawPath) {
    throw new Stage2Error("ZIP entry path must be non-empty");
  }
  if (
    rawPath.includes("\\") ||
    rawPath.includes(":") ||
    rawPath.startsWith("/") ||
    rawPath.endsWith("/") ||
    /[\x00-\x1f\x7f]/.test(rawPath) ||
    rawPath.includes("//")
  ) {
    throw new Stage2Error(`unsafe ZIP entry path: ${sanitizeText(rawPath)}`);
  }
  for (const seg of rawPath.split("/")) {
    if (!seg || seg === "." || seg === ".." || seg.endsWith(".") || seg.endsWith(" ")) {
      throw new Stage2Error(`unsafe ZIP entry segment: ${sanitizeText(rawPath)}`);
    }
  }
  return rawPath;
}

export function parseZipBuffer(zipBuffer) {
  const buf = Buffer.isBuffer(zipBuffer) ? zipBuffer : Buffer.from(zipBuffer);
  if (
    buf.length < 22 ||
    buf[0] !== 0x50 ||
    buf[1] !== 0x4b ||
    buf[2] !== 0x03 ||
    buf[3] !== 0x04
  ) {
    throw new Stage2Error("invalid PKZIP header magic");
  }

  // Locate End of Central Directory record (0x06054b50)
  const minOffset = Math.max(0, buf.length - 65557);
  let eocdOffset = -1;
  for (let i = buf.length - 22; i >= minOffset; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      const commentLen = buf.readUInt16LE(i + 20);
      if (i + 22 + commentLen === buf.length) {
        eocdOffset = i;
        break;
      }
    }
  }
  if (eocdOffset < 0) {
    throw new Stage2Error("missing ZIP end-of-central-directory record");
  }

  const totalEntries = buf.readUInt16LE(eocdOffset + 10);
  const cdSize = buf.readUInt32LE(eocdOffset + 12);
  const cdOffset = buf.readUInt32LE(eocdOffset + 16);
  if (cdOffset + cdSize > eocdOffset) {
    throw new Stage2Error("corrupt ZIP central directory bounds");
  }

  const entries = new Map();
  const seenNormalizedNames = new Set();
  let cursor = cdOffset;
  let totalUncompressed = 0;

  for (let i = 0; i < totalEntries; i++) {
    if (cursor + 46 > cdOffset + cdSize) {
      throw new Stage2Error("truncated ZIP central directory header");
    }
    if (buf.readUInt32LE(cursor) !== 0x02014b50) {
      throw new Stage2Error("invalid ZIP central directory signature");
    }
    const method = buf.readUInt16LE(cursor + 10);
    const expectedCrc = buf.readUInt32LE(cursor + 16);
    const compSize = buf.readUInt32LE(cursor + 20);
    const uncompSize = buf.readUInt32LE(cursor + 24);
    const nameLen = buf.readUInt16LE(cursor + 28);
    const extraLen = buf.readUInt16LE(cursor + 30);
    const commentLen = buf.readUInt16LE(cursor + 32);
    const extAttrs = buf.readUInt32LE(cursor + 38);
    const localOffset = buf.readUInt32LE(cursor + 42);

    const entryEnd = cursor + 46 + nameLen + extraLen + commentLen;
    if (entryEnd > cdOffset + cdSize) {
      throw new Stage2Error("truncated ZIP central directory entry");
    }

    const unixMode = (extAttrs >>> 16) & 0o170000;
    if (unixMode === 0o120000) {
      throw new Stage2Error("symlink entries are forbidden in extension ZIP");
    }

    const rawName = buf
      .subarray(cursor + 46, cursor + 46 + nameLen)
      .toString("utf8");
    const entryName = normalizeZipEntryPath(rawName);
    const canonicalName = entryName.normalize("NFC").toLowerCase();
    if (entries.has(entryName) || seenNormalizedNames.has(canonicalName)) {
      throw new Stage2Error(`duplicate or case-colliding ZIP entry: ${entryName}`);
    }
    seenNormalizedNames.add(canonicalName);

    if (uncompSize > MAX_ZIP_ENTRY_BYTES) {
      throw new Stage2Error(`ZIP entry exceeds size limit: ${entryName}`);
    }
    totalUncompressed += uncompSize;
    if (totalUncompressed > MAX_ZIP_TOTAL_BYTES) {
      throw new Stage2Error("ZIP archive total uncompressed size exceeds limit");
    }

    if (localOffset + 30 > cdOffset) {
      throw new Stage2Error(`invalid local header offset for ${entryName}`);
    }
    if (buf.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new Stage2Error(`invalid local file header signature for ${entryName}`);
    }
    const localNameLen = buf.readUInt16LE(localOffset + 26);
    const localExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const dataEnd = dataStart + compSize;
    if (dataEnd > cdOffset) {
      throw new Stage2Error(`truncated compressed payload for ${entryName}`);
    }

    const compressed = buf.subarray(dataStart, dataEnd);
    let data;
    if (method === 0) {
      data = Buffer.from(compressed);
    } else if (method === 8) {
      data = zlib.inflateRawSync(compressed, {
        maxOutputLength: MAX_ZIP_ENTRY_BYTES,
      });
    } else {
      throw new Stage2Error(`unsupported ZIP compression method ${method} for ${entryName}`);
    }

    if (data.length !== uncompSize) {
      throw new Stage2Error(`uncompressed size mismatch for ${entryName}`);
    }
    const actualCrc = zlib.crc32(data) >>> 0;
    if (actualCrc !== expectedCrc) {
      throw new Stage2Error(`CRC32 mismatch for ${entryName}`);
    }

    entries.set(entryName, data);
    cursor = entryEnd;
  }

  return {
    entries,
    entryNames: Array.from(entries.keys()),
  };
}

export function validateExtensionArchive(zipBuffer, options = {}) {
  const {
    target,
    manifestData = null,
    expectedExtVersion = "",
    expectedExtFiles = null,
  } = options;

  const actualSha256 = crypto
    .createHash("sha256")
    .update(zipBuffer)
    .digest("hex");
  const actualSize = zipBuffer.length;

  let manifestVerifiedAgainstRelease = false;
  if (manifestData) {
    const artifactMeta = manifestData.artifacts?.["dokitool-chrome-extension.zip"];
    const expectedArtifactSha =
      typeof artifactMeta?.sha256 === "string" ? artifactMeta.sha256.trim().toLowerCase() : "";
    if (!/^[0-9a-f]{64}$/.test(expectedArtifactSha)) {
      throw new Stage2Error(
        "release-manifest missing valid artifacts['dokitool-chrome-extension.zip'].sha256",
      );
    }
    if (typeof artifactMeta?.size_bytes !== "number" || artifactMeta.size_bytes <= 0) {
      throw new Stage2Error(
        "release-manifest missing valid artifacts['dokitool-chrome-extension.zip'].size_bytes",
      );
    }
    if (expectedArtifactSha !== actualSha256) {
      throw new Stage2Error(
        `extension zip SHA-256 mismatch vs release-manifest artifacts (actual=${actualSha256.slice(0, 12)})`,
      );
    }
    if (artifactMeta.size_bytes !== actualSize) {
      throw new Stage2Error(
        `extension zip size mismatch vs release-manifest (expected=${artifactMeta.size_bytes}, actual=${actualSize})`,
      );
    }
    if (manifestData.frontend_dist_files && typeof manifestData.frontend_dist_files === "object") {
      const distShaRaw =
        manifestData.frontend_dist_files["helper/dokitool-chrome-extension.zip"];
      const distSha = typeof distShaRaw === "string" ? distShaRaw.trim().toLowerCase() : "";
      if (!/^[0-9a-f]{64}$/.test(distSha) || distSha !== actualSha256) {
        throw new Stage2Error(
          `extension zip SHA-256 mismatch vs frontend_dist_files (actual=${actualSha256.slice(0, 12)})`,
        );
      }
    }
    manifestVerifiedAgainstRelease = true;
  }

  const parsed = parseZipBuffer(zipBuffer);
  const { entries, entryNames } = parsed;

  if (
    expectedExtFiles !== null &&
    expectedExtFiles !== undefined &&
    entries.size !== expectedExtFiles
  ) {
    throw new Stage2Error(
      `extension zip entry count mismatch (expected=${expectedExtFiles}, actual=${entries.size})`,
    );
  }

  for (const rel of REQUIRED_EXTENSION_FILES) {
    const data = entries.get(rel);
    if (!data || data.length === 0) {
      throw new Stage2Error(`extension zip missing or empty required file: ${rel}`);
    }
  }

  if (
    entryNames.some(
      (n) =>
        n.toLowerCase() === "monitor.html" ||
        /^assets\/monitor-[^/]+\.js$/i.test(n),
    )
  ) {
    throw new Stage2Error("extension zip contains forbidden monitor bundle");
  }

  let extManifest;
  try {
    extManifest = JSON.parse(entries.get("manifest.json").toString("utf8"));
  } catch {
    throw new Stage2Error("extension manifest.json is not valid JSON");
  }

  if (!extManifest || typeof extManifest !== "object") {
    throw new Stage2Error("extension manifest.json must be an object");
  }
  if (extManifest.manifest_version !== 3) {
    throw new Stage2Error(
      `expected manifest_version 3, got ${extManifest.manifest_version}`,
    );
  }
  const version = String(extManifest.version || "").trim();
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Stage2Error(`invalid extension version: ${sanitizeText(version)}`);
  }
  if (expectedExtVersion && version !== expectedExtVersion) {
    throw new Stage2Error(
      `extension version mismatch (expected=${expectedExtVersion}, actual=${version})`,
    );
  }
  if (extManifest.content_scripts !== undefined) {
    throw new Stage2Error("forbidden content_scripts found in extension manifest");
  }

  const derivedId = deriveExtensionIdFromManifestKey(extManifest.key);
  if (derivedId !== DOKITOOL_EXTENSION_ID) {
    throw new Stage2Error(
      `extension ID mismatch (expected=${DOKITOOL_EXTENSION_ID}, actual=${derivedId})`,
    );
  }

  if (!Array.isArray(extManifest.permissions)) {
    throw new Stage2Error("extension manifest.permissions must be an array");
  }
  const allDeclaredPerms = [
    ...extManifest.permissions,
    ...(Array.isArray(extManifest.optional_permissions)
      ? extManifest.optional_permissions
      : []),
  ];
  for (const perm of allDeclaredPerms) {
    if (FORBIDDEN_EXTENSION_PERMISSIONS.includes(perm)) {
      throw new Stage2Error(
        `forbidden permission in extension manifest: ${perm}`,
      );
    }
    if (!ALLOWED_EXTENSION_PERMISSIONS.includes(perm)) {
      throw new Stage2Error(
        `unallowlisted permission in extension manifest: ${sanitizeText(perm)}`,
      );
    }
  }

  const hostPermLists = [
    extManifest.host_permissions,
    extManifest.optional_host_permissions,
  ].filter(Array.isArray);
  for (const list of hostPermLists) {
    for (const pat of list) {
      if (FORBIDDEN_HOST_WILDCARDS.includes(pat)) {
        throw new Stage2Error(
          `forbidden wildcard host permission in extension manifest: ${pat}`,
        );
      }
    }
  }

  const extConn = extManifest.externally_connectable;
  if (!extConn || typeof extConn !== "object" || !Array.isArray(extConn.matches)) {
    throw new Stage2Error(
      "extension manifest.externally_connectable.matches must be an array",
    );
  }
  if (extConn.ids !== undefined) {
    throw new Stage2Error("extension manifest.externally_connectable.ids must be undefined");
  }
  if (extConn.matches.length === 0) {
    throw new Stage2Error(
      "extension manifest.externally_connectable.matches must not be empty",
    );
  }
  for (const m of extConn.matches) {
    if (
      typeof m !== "string" ||
      FORBIDDEN_HOST_WILDCARDS.includes(m) ||
      m.includes("*.") ||
      m.includes("://*")
    ) {
      throw new Stage2Error("forbidden wildcard in externally_connectable.matches");
    }
  }

  if (target) {
    if (!target.isLoopback) {
      const expectedMatch = `${target.origin}/*`;
      if (
        extConn.matches.length !== 1 ||
        extConn.matches[0] !== expectedMatch
      ) {
        throw new Stage2Error(
          `externally_connectable.matches must contain only target origin (count=${extConn.matches.length})`,
        );
      }
    } else {
      const loopbackAllowed = extConn.matches.some(
        (m) =>
          m === `${target.origin}/*` ||
          m === "http://127.0.0.1/*" ||
          m === "http://localhost/*",
      );
      if (!loopbackAllowed) {
        throw new Stage2Error(
          "loopback target requires matching loopback entry in externally_connectable.matches",
        );
      }
    }
  }

  if (
    extManifest.content_security_policy?.extension_pages !==
    "script-src 'self'; object-src 'self';"
  ) {
    throw new Stage2Error("invalid extension_pages CSP in manifest.json");
  }

  return {
    sha256: actualSha256,
    sizeBytes: actualSize,
    fileCount: entries.size,
    version,
    extensionId: derivedId,
    externallyConnectableCount: extConn.matches.length,
    manifestVerifiedAgainstRelease,
    entries,
  };
}

export async function extractZipEntriesToDir(entries, destDir) {
  await fsp.mkdir(destDir, { recursive: true });
  for (const [relPosix, data] of entries.entries()) {
    const absDest = path.resolve(destDir, ...relPosix.split("/"));
    const resolvedRoot = path.resolve(destDir);
    if (
      absDest !== resolvedRoot &&
      !absDest.startsWith(resolvedRoot + path.sep)
    ) {
      throw new Stage2Error(`zip extraction path escape blocked: ${relPosix}`);
    }
    await fsp.mkdir(path.dirname(absDest), { recursive: true });
    await fsp.writeFile(absDest, data, { flag: "wx" });
  }
}

function findNearestExistingAncestor(absTarget) {
  let current = absTarget;
  while (true) {
    if (fs.existsSync(current)) return current;
    const parent = path.dirname(current);
    if (parent === current) return current;
    current = parent;
  }
}

export function assertPathNotGitTracked(targetDir) {
  if (typeof targetDir !== "string" || !targetDir.trim()) {
    throw new Stage2Error("invalid --sync-local-extension path");
  }
  const absTarget = path.resolve(targetDir);
  if (absTarget === path.parse(absTarget).root) {
    throw new Stage2Error("refusing to sync extension into filesystem root");
  }

  const realpathFn = fs.realpathSync.native || fs.realpathSync;
  const existingAncestor = findNearestExistingAncestor(absTarget);
  const realAncestor = realpathFn(existingAncestor);
  const relFromAncestor = path.relative(existingAncestor, absTarget);
  const resolvedTarget = relFromAncestor
    ? path.resolve(realAncestor, relFromAncestor)
    : realAncestor;

  const probeDir = fs.statSync(realAncestor).isDirectory()
    ? realAncestor
    : path.dirname(realAncestor);

  let gitTopRaw;
  try {
    gitTopRaw = execFileSync(
      "git",
      ["-C", probeDir, "rev-parse", "--show-toplevel"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ).trim();
  } catch (err) {
    const stderr = String(err?.stderr || "");
    if (/not a git repository/i.test(stderr)) {
      return { absTarget: resolvedTarget, inGitRepo: false };
    }
    // Fail closed if git check fails unexpectedly.
    throw new Stage2Error("failed to verify Git tracking status for sync target");
  }

  const gitRoot = realpathFn(gitTopRaw);
  const relToRepo = path.relative(gitRoot, resolvedTarget);
  if (!relToRepo || relToRepo === ".") {
    throw new Stage2Error("refusing to sync extension into Git repository root");
  }
  if (relToRepo.startsWith("..") || path.isAbsolute(relToRepo)) {
    return { absTarget: resolvedTarget, inGitRepo: false };
  }
  const relPosix = relToRepo.split(path.sep).join("/");
  const relPosixLower = relPosix.toLowerCase();
  if (relPosixLower === ".git" || relPosixLower.startsWith(".git/")) {
    throw new Stage2Error("refusing to sync extension inside .git directory");
  }

  let trackedOut;
  try {
    trackedOut = execFileSync(
      "git",
      ["-C", gitRoot, "ls-files", "-z", "--", relPosix],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch {
    throw new Stage2Error("failed to query git ls-files for sync target");
  }
  if (trackedOut && trackedOut.replace(/\0/g, "").length > 0) {
    throw new Stage2Error(
      "refusing --sync-local-extension: target path is tracked by Git",
    );
  }

  // Also ensure no ancestor component itself is a Git-tracked file.
  const segments = relPosix.split("/");
  for (let i = 1; i <= segments.length; i++) {
    const prefix = segments.slice(0, i).join("/");
    const exact = execFileSync(
      "git",
      ["-C", gitRoot, "ls-files", "-z", "--", prefix],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    const items = exact.split("\0").filter(Boolean);
    if (items.includes(prefix)) {
      throw new Stage2Error(
        "refusing --sync-local-extension: target path collides with a Git-tracked file",
      );
    }
  }

  return { absTarget: resolvedTarget, inGitRepo: true, gitRoot, relPosix };
}

export async function syncExtensionAtomic(archiveInfo, targetDir) {
  if (!archiveInfo?.manifestVerifiedAgainstRelease) {
    throw new Stage2Error(
      "refusing --sync-local-extension: archive digest was not verified against --manifest",
    );
  }
  const checked = assertPathNotGitTracked(targetDir);
  const finalDir = checked.absTarget;

  // Monotonic anti-downgrade check when overwriting an existing local extension installation.
  const existingManifestPath = path.join(finalDir, "manifest.json");
  if (fs.existsSync(existingManifestPath)) {
    let existingVersion = "";
    try {
      const existingManifest = JSON.parse(
        await fsp.readFile(existingManifestPath, "utf8"),
      );
      existingVersion = String(existingManifest?.version || "").trim();
    } catch {
      existingVersion = "";
    }
    if (
      /^\d+\.\d+\.\d+$/.test(existingVersion) &&
      compareSemver(archiveInfo.version, existingVersion) < 0
    ) {
      throw new Stage2Error(
        `refusing extension downgrade (installed=${existingVersion}, candidate=${archiveInfo.version})`,
      );
    }
  }

  const parentDir = path.dirname(finalDir);
  await fsp.mkdir(parentDir, { recursive: true });

  const suffix = `${process.pid}-${crypto.randomBytes(6).toString("hex")}`;
  const stageDir = path.join(parentDir, `.${path.basename(finalDir)}.stage-${suffix}`);
  const backupDir = path.join(parentDir, `.${path.basename(finalDir)}.prev-${suffix}`);
  let movedExisting = false;

  try {
    await extractZipEntriesToDir(archiveInfo.entries, stageDir);
    if (fs.existsSync(finalDir)) {
      await fsp.rename(finalDir, backupDir);
      movedExisting = true;
    }
    await fsp.rename(stageDir, finalDir);
    if (movedExisting) {
      await fsp.rm(backupDir, { recursive: true, force: true }).catch(() => {});
    }
    return {
      synced: true,
      fileCount: archiveInfo.fileCount,
      sha256: archiveInfo.sha256,
      version: archiveInfo.version,
    };
  } catch (err) {
    if (movedExisting && !fs.existsSync(finalDir) && fs.existsSync(backupDir)) {
      await fsp.rename(backupDir, finalDir).catch(() => {});
    }
    await fsp.rm(stageDir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}

// ============================================================================
// Silent Headless Chrome Process Manager & CDP Helpers
// ============================================================================

function isPidAlive(pid) {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === "EPERM";
  }
}

function killProcessTree(pid, signal) {
  if (!pid || pid <= 0) return;
  if (process.platform === "win32") {
    try {
      execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
        stdio: "ignore",
      });
    } catch {
      try {
        process.kill(pid, signal);
      } catch {
        // already dead
      }
    }
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    // fallback to single pid
  }
  try {
    process.kill(pid, signal);
  } catch {
    // already dead
  }
}

function listResidualPidsByRunTag(runTag) {
  if (!runTag || process.platform === "win32") return [];
  const currentUid = typeof process.getuid === "function" ? process.getuid() : null;
  try {
    const output = execFileSync("ps", ["-ax", "-o", "uid=,pid=,command="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const pids = [];
    for (const line of output.split(/\r?\n/)) {
      if (!line.includes(runTag)) continue;
      const m = /^\s*(\d+)\s+(\d+)\s+/.exec(line);
      if (!m) continue;
      const uid = Number(m[1]);
      const pid = Number(m[2]);
      if (currentUid !== null && uid !== currentUid) continue;
      if (pid && pid !== process.pid) {
        pids.push(pid);
      }
    }
    return pids;
  } catch {
    return [];
  }
}

function settleWithin(promise, timeoutMs) {
  let timer = null;
  const timeoutPromise = new Promise((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
    timer.unref?.();
  });
  return Promise.race([
    promise.then(
      () => {},
      () => {},
    ),
    timeoutPromise,
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

export class ChromeProcessPool {
  constructor(chromeBin, proxyConfig) {
    this.chromeBin = chromeBin;
    this.proxyConfig = proxyConfig;
    this.runTag = `dokitool-stage2-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
    this.tmpRoot = null;
    this.instances = [];
    this.closing = false;
    this.cleanedUp = false;
    this._initPromise = null;
    this._cleanupPromise = null;
    this._inflightLaunches = new Set();
  }

  async init() {
    if (this.closing) {
      throw new Stage2Error("ChromeProcessPool is shutting down");
    }
    if (this.tmpRoot) return this.tmpRoot;
    this._initPromise ??= (async () => {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), `${this.runTag}-`));
      if (this.closing) {
        await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
        throw new Stage2Error("ChromeProcessPool is shutting down");
      }
      this.tmpRoot = root;
      return root;
    })();
    return this._initPromise;
  }

  async launch(opts) {
    if (this.closing) {
      throw new Stage2Error("ChromeProcessPool is shutting down");
    }
    const launchPromise = this.#doLaunch(opts);
    const settled = launchPromise.then(
      () => {},
      () => {},
    );
    this._inflightLaunches.add(settled);
    try {
      return await launchPromise;
    } finally {
      this._inflightLaunches.delete(settled);
    }
  }

  async #doLaunch({ name, extensionDir = null, expectedExtensionId = DOKITOOL_EXTENSION_ID, downloadDir = null }) {
    if (this.closing) {
      throw new Stage2Error("ChromeProcessPool is shutting down");
    }
    if (!this.tmpRoot) await this.init();
    if (this.closing) {
      throw new Stage2Error("ChromeProcessPool is shutting down");
    }
    const profileDir = path.join(this.tmpRoot, `profile-${name}`);
    await fsp.mkdir(path.join(profileDir, "Default"), { recursive: true });

    if (downloadDir) {
      await fsp.mkdir(downloadDir, { recursive: true });
      const prefs = {
        download: {
          default_directory: downloadDir,
          prompt_for_download: false,
          directory_upgrade: true,
        },
        profile: {
          default_content_setting_values: {
            automatic_downloads: 1,
          },
        },
      };
      await fsp.writeFile(
        path.join(profileDir, "Default", "Preferences"),
        JSON.stringify(prefs),
        "utf8",
      );
    }

    const usePipeTransport = process.platform !== "win32";
    const args = [
      ...MANDATORY_HEADLESS_FLAGS,
      usePipeTransport ? "--remote-debugging-pipe" : "--remote-debugging-port=0",
      `--user-data-dir=${profileDir}`,
      "--window-size=1440,900",
      "--disable-sync",
      "--disable-default-apps",
      "--disable-component-update",
      "--no-pings",
      "--mute-audio",
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
    ];

    if (this.proxyConfig?.proxy) {
      args.push(`--proxy-server=${this.proxyConfig.proxy.origin}`);
      if (this.proxyConfig.bypassList) {
        args.push(`--proxy-bypass-list=${this.proxyConfig.bypassList}`);
      }
    } else if (this.proxyConfig?.forceNoProxy) {
      args.push("--no-proxy-server");
    }

    if (extensionDir) {
      const supportsCliLoadExtension =
        /chrome for testing|chromium|ms-playwright/i.test(this.chromeBin);
      if (supportsCliLoadExtension) {
        args.push(
          `--disable-extensions-except=${extensionDir}`,
          `--load-extension=${extensionDir}`,
        );
      } else {
        args.push("--enable-unsafe-extension-debugging");
      }
    }

    args.push("about:blank");

    if (this.closing) {
      if (this.tmpRoot) {
        await fsp.rm(this.tmpRoot, { recursive: true, force: true }).catch(() => {});
      }
      throw new Stage2Error("ChromeProcessPool is shutting down");
    }

    const stderrChunks = [];
    let stderrBytes = 0;
    const child = spawn(this.chromeBin, args, {
      detached: process.platform !== "win32",
      stdio: usePipeTransport
        ? ["ignore", "ignore", "pipe", "pipe", "pipe"]
        : ["ignore", "ignore", "pipe"],
    });
    child.stderr?.on("data", (chunk) => {
      if (stderrBytes < 8192) {
        stderrChunks.push(chunk);
        stderrBytes += chunk.length;
      }
    });

    const instance = {
      name,
      child,
      pid: child.pid,
      profileDir,
      browser: null,
      exited: false,
    };
    let spawnError = null;
    child.once("error", (err) => {
      spawnError = err;
      instance.exited = true;
    });
    child.once("exit", () => {
      instance.exited = true;
    });
    this.instances.push(instance);

    if (this.closing) {
      await this.#terminateInstance(instance);
      throw new Stage2Error("ChromeProcessPool is shutting down");
    }

    const listeners = new Set();
    const onEvent = (packet) => {
      for (const fn of listeners) {
        try {
          fn(packet);
        } catch {
          // ignore listener errors
        }
      }
    };

    try {
      let browser;
      let versionInfo;
      if (usePipeTransport) {
        browser = connectPipe(child, onEvent);
        instance.browser = browser;
        versionInfo = await until(
          async () => {
            if (this.closing) {
              throw new Stage2Error("ChromeProcessPool is shutting down");
            }
            if (spawnError) {
              throw new Stage2Error(
                `Chrome (${name}) failed to spawn: ${sanitizeText(spawnError.message)}`,
              );
            }
            if (instance.exited) {
              const tail = Buffer.concat(stderrChunks).toString("utf8").slice(-400);
              throw new Stage2Error(
                `Chrome (${name}) exited prematurely: ${sanitizeText(tail)}`,
              );
            }
            return browser.send("Browser.getVersion").catch(() => null);
          },
          `Chrome (${name}) DevTools pipe connection`,
          15_000,
        );
      } else {
        browser = await until(
          async () => {
            if (this.closing) {
              throw new Stage2Error("ChromeProcessPool is shutting down");
            }
            if (spawnError) {
              throw new Stage2Error(
                `Chrome (${name}) failed to spawn: ${sanitizeText(spawnError.message)}`,
              );
            }
            if (instance.exited) {
              const tail = Buffer.concat(stderrChunks).toString("utf8").slice(-400);
              throw new Stage2Error(
                `Chrome (${name}) exited prematurely: ${sanitizeText(tail)}`,
              );
            }
            return connect(profileDir, onEvent).catch(() => null);
          },
          `Chrome (${name}) DevTools connection`,
          15_000,
        );
        instance.browser = browser;
        versionInfo = await browser.send("Browser.getVersion");
      }
      if (this.closing) {
        throw new Stage2Error("ChromeProcessPool is shutting down");
      }
      // NOTE: Do NOT call `Browser.setDownloadBehavior({ behavior: "allow" })` when
      // testing `chrome.downloads` extensions: CDP's `allow` mode installs
      // `DevToolsDownloadManagerDelegate`, which bypasses `ChromeDownloadManagerDelegate`
      // and replaces saved filenames with random 36-char GUIDs (short-circuiting both
      // extension-provided filenames and `onDeterminingFilename` listeners).
      // `Default/Preferences` (`download.default_directory`, `prompt_for_download: false`,
      // `automatic_downloads: 1`) configured above natively drives Chrome's real download
      // manager in `--headless=new`.

      let extensionLoadMethod = null;
      if (extensionDir) {
        const targetsRes = await browser.send("Target.getTargets");
        const alreadyLoaded = (targetsRes.targetInfos || []).some(
          (t) =>
            typeof t.url === "string" &&
            t.url.startsWith(`chrome-extension://${expectedExtensionId}/`),
        );
        if (alreadyLoaded) {
          extensionLoadMethod = "cli-flag";
        } else {
          // Branded Chrome 137+ disables --load-extension; load via CDP Extensions.loadUnpacked.
          const loaded = await browser.send("Extensions.loadUnpacked", {
            path: extensionDir,
          });
          if (loaded?.id !== expectedExtensionId) {
            throw new Stage2Error(
              `CDP Extensions.loadUnpacked returned unexpected ID (expected=${expectedExtensionId}, actual=${sanitizeText(loaded?.id)})`,
            );
          }
          extensionLoadMethod = "cdp-loadUnpacked";
        }
      }

      if (this.closing) {
        throw new Stage2Error("ChromeProcessPool is shutting down");
      }

      return {
        name,
        browser,
        send: browser.send,
        versionInfo,
        extensionLoadMethod,
        addEventListener: (fn) => {
          listeners.add(fn);
          return () => listeners.delete(fn);
        },
      };
    } catch (err) {
      await this.#terminateInstance(instance);
      throw err;
    }
  }

  async #terminateInstance(instance) {
    try {
      if (instance.browser) {
        await settleWithin(instance.browser.send("Browser.close"), 1200);
        try {
          instance.browser.close();
        } catch {
          // ignore
        }
        instance.browser = null;
      }
    } catch {
      // ignore
    }

    if (!instance.exited && instance.pid) {
      killProcessTree(instance.pid, "SIGTERM");
      const deadline = Date.now() + 2500;
      while (!instance.exited && isPidAlive(instance.pid) && Date.now() < deadline) {
        await delay(50);
      }
      if (!instance.exited || isPidAlive(instance.pid)) {
        killProcessTree(instance.pid, "SIGKILL");
        const killDeadline = Date.now() + 1500;
        while (isPidAlive(instance.pid) && Date.now() < killDeadline) {
          await delay(50);
        }
      }
    }

    try {
      instance.child?.stderr?.destroy();
      instance.child?.stdio?.[3]?.destroy();
      instance.child?.stdio?.[4]?.destroy();
      instance.child?.unref?.();
    } catch {
      // ignore
    }
  }

  cleanupAll() {
    this.closing = true;
    return (this._cleanupPromise ??= this.#doCleanupAll());
  }

  async #doCleanupAll() {
    await Promise.all(
      this.instances.map((inst) => this.#terminateInstance(inst)),
    );

    if (this._initPromise) {
      await this._initPromise.catch(() => {});
    }

    if (this._inflightLaunches.size > 0) {
      await settleWithin(
        Promise.allSettled([...this._inflightLaunches]),
        3000,
      );
    }

    // Re-terminate defensively in case an in-flight launch pushed an instance before settling.
    await Promise.all(
      this.instances.map((inst) => this.#terminateInstance(inst)),
    );

    let residualPids = this.instances
      .map((inst) => inst.pid)
      .filter((pid) => isPidAlive(pid));

    for (const pid of listResidualPidsByRunTag(this.runTag)) {
      if (!residualPids.includes(pid)) residualPids.push(pid);
    }

    if (residualPids.length > 0) {
      for (const pid of residualPids) {
        killProcessTree(pid, "SIGKILL");
      }
      await delay(300);
      residualPids = residualPids.filter((pid) => isPidAlive(pid));
      for (const pid of listResidualPidsByRunTag(this.runTag)) {
        if (!residualPids.includes(pid)) residualPids.push(pid);
      }
    }

    if (this.tmpRoot) {
      await fsp.rm(this.tmpRoot, { recursive: true, force: true }).catch(() => {});
    }

    this.cleanedUp = true;
    return { residualChrome: residualPids.length };
  }
}

async function createPageSession(chromeHandle, initialUrl = "about:blank") {
  const { send } = chromeHandle;
  const { targetId } = await send("Target.createTarget", { url: initialUrl });
  const { sessionId } = await send("Target.attachToTarget", {
    targetId,
    flatten: true,
  });

  const cdpExceptions = [];
  const cdpConsoleErrors = [];
  const cdpLogErrors = [];

  const removeListener = chromeHandle.addEventListener((packet) => {
    if (packet.sessionId !== sessionId) return;
    if (packet.method === "Runtime.exceptionThrown") {
      const desc =
        packet.params?.exceptionDetails?.exception?.description ||
        packet.params?.exceptionDetails?.text ||
        "Runtime.exceptionThrown";
      cdpExceptions.push(sanitizeText(desc));
    } else if (
      packet.method === "Runtime.consoleAPICalled" &&
      packet.params?.type === "error"
    ) {
      const parts = (packet.params.args || []).map((a) =>
        a.value !== undefined ? String(a.value) : String(a.description || a.type || ""),
      );
      cdpConsoleErrors.push(sanitizeText(parts.join(" ") || "console.error"));
    } else if (
      packet.method === "Log.entryAdded" &&
      packet.params?.entry?.level === "error"
    ) {
      cdpLogErrors.push(sanitizeText(packet.params.entry.text || "Log.error"));
    }
  });

  await send("Page.enable", {}, sessionId);
  await send("Runtime.enable", {}, sessionId);
  await send("Log.enable", {}, sessionId);
  await send(
    "Page.addScriptToEvaluateOnNewDocument",
    {
      source: `(() => {
        if (window.__STAGE2_PROBE__) return;
        const csp = [];
        const pageErrors = [];
        window.__STAGE2_PROBE__ = { csp, pageErrors };
        document.addEventListener('securitypolicyviolation', (e) => {
          csp.push({
            directive: String(e.effectiveDirective || e.violatedDirective || ''),
            disposition: String(e.disposition || ''),
            lineNumber: Number(e.lineNumber || 0),
          });
        }, true);
        window.addEventListener('error', (e) => {
          pageErrors.push(String(e.message || 'window.error'));
        });
        window.addEventListener('unhandledrejection', (e) => {
          const r = e.reason;
          pageErrors.push(String((r && r.message) || r || 'unhandledrejection'));
        });
      })();`,
    },
    sessionId,
  );

  async function evaluate(expression, options = {}) {
    const reply = await send(
      "Runtime.evaluate",
      {
        expression,
        awaitPromise: options.awaitPromise !== false,
        returnByValue: true,
        userGesture: Boolean(options.userGesture),
      },
      sessionId,
    );
    if (reply.exceptionDetails) {
      const msg =
        reply.exceptionDetails.exception?.description ||
        reply.exceptionDetails.text ||
        "Runtime.evaluate exception";
      throw new Stage2Error(sanitizeText(msg));
    }
    return reply.result?.value;
  }

  function resetErrors() {
    cdpExceptions.length = 0;
    cdpConsoleErrors.length = 0;
    cdpLogErrors.length = 0;
  }

  async function resetAllErrors() {
    resetErrors();
    await evaluate(`(() => {
      if (window.__STAGE2_PROBE__) {
        window.__STAGE2_PROBE__.csp.length = 0;
        window.__STAGE2_PROBE__.pageErrors.length = 0;
      }
    })()`).catch(() => {});
  }

  async function collectErrors() {
    const domProbe = await evaluate(
      "window.__STAGE2_PROBE__ || { csp: [], pageErrors: [] }",
    ).catch(() => ({ csp: [], pageErrors: [] }));
    const csp = Array.isArray(domProbe?.csp) ? domProbe.csp : [];
    const pageErrors = [
      ...(Array.isArray(domProbe?.pageErrors)
        ? domProbe.pageErrors.map((e) => sanitizeText(e))
        : []),
      ...cdpExceptions,
    ];
    const consoleErrors = [...cdpConsoleErrors, ...cdpLogErrors];
    return { csp, pageErrors, consoleErrors };
  }

  async function navigate(url, timeoutMs = 20_000) {
    resetErrors();
    await send("Page.navigate", { url }, sessionId);
    await until(
      async () => {
        const state = await evaluate("document.readyState").catch(() => "");
        return state === "complete";
      },
      `page complete (${sanitizeHostname(new URL(url).hostname)})`,
      timeoutMs,
    );
  }

  return {
    targetId,
    sessionId,
    send: (method, params = {}) => send(method, params, sessionId),
    evaluate,
    navigate,
    resetErrors,
    resetAllErrors,
    collectErrors,
    dispose: () => removeListener(),
  };
}

// ============================================================================
// Check Implementations
// ============================================================================

function makeCheck({
  id,
  group,
  status,
  elapsedMs = 0,
  mediaHostnames = [],
  note = "",
}) {
  const hosts = Array.from(
    new Set(
      (mediaHostnames || [])
        .map((h) => sanitizeHostname(h))
        .filter(Boolean),
    ),
  ).sort();
  return {
    id: sanitizeText(id),
    group: sanitizeText(group),
    status,
    elapsed_ms: Math.max(0, Math.round(elapsedMs)),
    media_hostnames: hosts,
    note: sanitizeText(note),
  };
}

async function runHttpChecks({ client, target, manifestData, skipHttpChecks }) {
  const skippedIds = [
    "http_worker_build",
    "http_home_headers",
    "http_monitor_headers",
    "http_precompressed_br",
    "http_llms_txt",
    "http_extension_version_json",
    "http_true_404",
    "http_api_stats_unauth",
  ];
  if (skipHttpChecks) {
    return {
      checks: skippedIds.map((id) =>
        makeCheck({
          id,
          group: "http_security",
          status: "SKIP",
          note: "skipped via --skip-http-checks",
        }),
      ),
      workerBuild: "",
      extensionVersionMeta: null,
    };
  }

  const nonce = crypto.randomBytes(6).toString("hex");
  const manifestMainJs = manifestData
    ? Object.keys(manifestData.frontend_dist_files || {}).find((k) =>
        /^assets\/main-[A-Za-z0-9_-]+\.js$/.test(k),
      )
    : null;

  const [
    workerRes,
    homeRes,
    bridgeRes,
    monitorRes,
    llmsRes,
    extVerRes,
    missingRootRes,
    missingAssetRes,
    statsRes,
  ] = await Promise.all([
    client.get("/downloads/worker.js").catch((e) => ({ error: e })),
    client.get("/", { accept: "text/html" }).catch((e) => ({ error: e })),
    client.get("/downloads/bridge.html", { accept: "text/html" }).catch((e) => ({ error: e })),
    client.get("/monitor", { accept: "text/html" }).catch((e) => ({ error: e })),
    client.get("/llms.txt", { accept: "text/plain" }).catch((e) => ({ error: e })),
    client.get("/helper/extension-version.json", { accept: "application/json" }).catch((e) => ({ error: e })),
    client.get(`/__stage2_missing_${nonce}`).catch((e) => ({ error: e })),
    client.get(`/assets/__stage2_missing_${nonce}.js`).catch((e) => ({ error: e })),
    client
      .get("/api/stats?schema_version=1.0", { accept: "application/json" })
      .catch((e) => ({ error: e })),
  ]);

  const checks = [];
  let discoveredWorkerBuild = "";

  // 1. /downloads/worker.js BUILD & SHA-256
  {
    const fails = [];
    let note = "";
    if (workerRes.error) {
      fails.push(sanitizeText(workerRes.error.message));
    } else {
      if (workerRes.status !== 200) fails.push(`HTTP ${workerRes.status}`);
      const text = workerRes.body.toString("utf8");
      const m = /const\s+BUILD\s*=\s*"([^"]+)"/.exec(text);
      if (!m) {
        fails.push("BUILD constant missing");
      } else {
        discoveredWorkerBuild = m[1];
      }
      const xfo = (workerRes.headers["x-frame-options"] || "").toUpperCase();
      if (xfo !== "DENY") fails.push(`X-Frame-Options=${xfo || "missing"}`);
      const cc = (workerRes.headers["cache-control"] || "").toLowerCase();
      if (!cc.includes("no-cache")) fails.push(`Cache-Control=${cc || "missing"}`);
      const sha = crypto.createHash("sha256").update(workerRes.body).digest("hex");
      const expectedSha = manifestData?.frontend_dist_files?.["downloads/worker.js"];
      if (expectedSha && sha !== expectedSha) {
        fails.push(`sha256 mismatch (${sha.slice(0, 12)})`);
      }
      note = `BUILD=${discoveredWorkerBuild || "-"}, sha256[:12]=${sha.slice(0, 12)}, XFO=${xfo}`;
    }
    checks.push(
      makeCheck({
        id: "http_worker_build",
        group: "http_security",
        status: fails.length === 0 ? "PASS" : "FAIL",
        elapsedMs: workerRes.elapsedMs || 0,
        note: fails.length === 0 ? note : fails.join("; "),
      }),
    );
  }

  // 2. / & /downloads/bridge.html security headers
  let discoveredMainJs = manifestMainJs ? "/" + manifestMainJs : "";
  {
    const fails = [];
    let elapsed = (homeRes.elapsedMs || 0) + (bridgeRes.elapsedMs || 0);
    if (homeRes.error) {
      fails.push(`home: ${sanitizeText(homeRes.error.message)}`);
    } else {
      if (homeRes.status !== 200) fails.push(`home HTTP ${homeRes.status}`);
      const h = homeRes.headers;
      if ((h["x-content-type-options"] || "").toLowerCase() !== "nosniff") {
        fails.push("home missing nosniff");
      }
      if ((h["referrer-policy"] || "").toLowerCase() !== "no-referrer") {
        fails.push("home missing no-referrer");
      }
      if ((h["x-frame-options"] || "").toUpperCase() !== "DENY") {
        fails.push("home X-Frame-Options != DENY");
      }
      if (!h["permissions-policy"]) {
        fails.push("home missing Permissions-Policy");
      }
      if (
        target.protocol === "https:" &&
        !(h["strict-transport-security"] || "").toLowerCase().includes("max-age=")
      ) {
        fails.push("home missing HSTS");
      }
      const csp = h["content-security-policy"] || "";
      if (!csp.includes("frame-ancestors 'none'")) fails.push("home CSP missing frame-ancestors 'none'");
      if (!csp.includes("object-src 'none'")) fails.push("home CSP missing object-src 'none'");
      if (!csp.includes("frame-src 'self'")) fails.push("home CSP missing frame-src 'self'");
      if (!/script-src\s+[^;]*'self'[^;]*'sha256-[A-Za-z0-9+/=]+'/.test(csp)) {
        fails.push("home CSP missing script-src sha256 hash");
      }
      if (/unsafe-eval/i.test(csp)) fails.push("home CSP contains unsafe-eval");

      if (!discoveredMainJs) {
        const html = homeRes.body.toString("utf8");
        const m = /src="(\/assets\/main-[A-Za-z0-9_-]+\.js)"/.exec(html);
        if (m) discoveredMainJs = m[1];
      }
    }

    if (bridgeRes.error) {
      fails.push(`bridge: ${sanitizeText(bridgeRes.error.message)}`);
    } else {
      if (bridgeRes.status !== 200) fails.push(`bridge HTTP ${bridgeRes.status}`);
      const bh = bridgeRes.headers;
      if ((bh["x-frame-options"] || "").toUpperCase() !== "SAMEORIGIN") {
        fails.push("bridge X-Frame-Options != SAMEORIGIN");
      }
      if (!(bh["cache-control"] || "").toLowerCase().includes("no-store")) {
        fails.push("bridge Cache-Control != no-store");
      }
      if (!(bh["content-security-policy"] || "").includes("frame-ancestors 'self'")) {
        fails.push("bridge CSP missing frame-ancestors 'self'");
      }
      if (!bridgeRes.body.toString("utf8").includes('id="dokitool-download-bridge"')) {
        fails.push("bridge HTML missing dokitool-download-bridge marker");
      }
    }

    checks.push(
      makeCheck({
        id: "http_home_headers",
        group: "http_security",
        status: fails.length === 0 ? "PASS" : "FAIL",
        elapsedMs: elapsed,
        note:
          fails.length === 0
            ? "home DENY + HSTS/Permissions-Policy/CSP(sha256); bridge SAMEORIGIN + no-store + frame-ancestors 'self'"
            : fails.join("; "),
      }),
    );
  }

  // 3. /monitor strict zero-inline CSP headers
  {
    const fails = [];
    if (monitorRes.error) {
      fails.push(sanitizeText(monitorRes.error.message));
    } else {
      if (monitorRes.status !== 200) fails.push(`HTTP ${monitorRes.status}`);
      const h = monitorRes.headers;
      if ((h["x-frame-options"] || "").toUpperCase() !== "DENY") {
        fails.push("X-Frame-Options != DENY");
      }
      if (!(h["cache-control"] || "").toLowerCase().includes("no-store")) {
        fails.push("Cache-Control != no-store");
      }
      if (!(h["x-robots-tag"] || "").toLowerCase().includes("noindex")) {
        fails.push("X-Robots-Tag missing noindex");
      }
      const csp = h["content-security-policy"] || "";
      for (const req of [
        "default-src 'none'",
        "script-src 'self'",
        "style-src 'self'",
        "frame-ancestors 'none'",
      ]) {
        if (!csp.includes(req)) fails.push(`monitor CSP missing ${req}`);
      }
      if (/unsafe-inline|unsafe-eval/i.test(csp)) {
        fails.push("monitor CSP allows unsafe inline/eval");
      }
    }
    checks.push(
      makeCheck({
        id: "http_monitor_headers",
        group: "http_security",
        status: fails.length === 0 ? "PASS" : "FAIL",
        elapsedMs: monitorRes.elapsedMs || 0,
        note:
          fails.length === 0
            ? "/monitor 200 DENY + no-store + noindex + strict zero-inline CSP"
            : fails.join("; "),
      }),
    );
  }

  // 4. Precompressed Brotli asset check
  {
    const fails = [];
    let elapsedMs = 0;
    let note = "";
    if (!discoveredMainJs) {
      fails.push("could not determine /assets/main-*.js path");
    } else {
      const brRes = await client
        .get(discoveredMainJs, {
          accept: "*/*",
          acceptEncoding: "br, zstd, gzip",
        })
        .catch((e) => ({ error: e }));
      if (brRes.error) {
        fails.push(sanitizeText(brRes.error.message));
      } else {
        elapsedMs = brRes.elapsedMs;
        if (brRes.status !== 200) fails.push(`HTTP ${brRes.status}`);
        const encList = (brRes.headerLists["content-encoding"] || []).map((v) =>
          v.trim().toLowerCase(),
        );
        if (encList.length !== 1 || encList[0] !== "br") {
          fails.push(`Content-Encoding=${encList.join(",") || "none"} (expected single br)`);
        }
        const vary = (brRes.headers["vary"] || "").toLowerCase();
        if (!vary.includes("accept-encoding")) {
          fails.push("Vary missing Accept-Encoding");
        }
        const cc = (brRes.headers["cache-control"] || "").toLowerCase();
        if (!cc.includes("immutable")) {
          fails.push("Cache-Control missing immutable");
        }
        let rawSize = 0;
        if (encList[0] === "br") {
          try {
            const inflated = zlib.brotliDecompressSync(brRes.body, {
              maxOutputLength: MAX_HTTP_BODY_BYTES,
            });
            rawSize = inflated.length;
            const relKey = discoveredMainJs.replace(/^\//, "");
            const expectedBrSha = manifestData?.frontend_dist_files?.[`${relKey}.br`];
            const expectedRawSha = manifestData?.frontend_dist_files?.[relKey];
            const brSha = crypto.createHash("sha256").update(brRes.body).digest("hex");
            const rawSha = crypto.createHash("sha256").update(inflated).digest("hex");
            if (expectedBrSha && brSha !== expectedBrSha) {
              fails.push("compressed .br SHA-256 mismatch vs manifest");
            }
            if (expectedRawSha && rawSha !== expectedRawSha) {
              fails.push("decompressed JS SHA-256 mismatch vs manifest");
            }
          } catch {
            fails.push("brotli decompression failed");
          }
        }
        note = `${path.basename(discoveredMainJs)}: Content-Encoding=br (${brRes.body.length}B -> ${rawSize}B), Vary=Accept-Encoding, immutable`;
      }
    }
    checks.push(
      makeCheck({
        id: "http_precompressed_br",
        group: "http_security",
        status: fails.length === 0 ? "PASS" : "FAIL",
        elapsedMs,
        note: fails.length === 0 ? note : fails.join("; "),
      }),
    );
  }

  // 5. /llms.txt
  {
    const fails = [];
    let note = "";
    if (llmsRes.error) {
      fails.push(sanitizeText(llmsRes.error.message));
    } else {
      if (llmsRes.status !== 200) fails.push(`HTTP ${llmsRes.status}`);
      const ct = (llmsRes.headers["content-type"] || "").toLowerCase();
      if (!ct.startsWith("text/plain")) fails.push(`Content-Type=${ct || "missing"}`);
      if (llmsRes.body.length === 0) fails.push("empty body");
      const sha = crypto.createHash("sha256").update(llmsRes.body).digest("hex");
      const expectedSha = manifestData?.frontend_dist_files?.["llms.txt"];
      if (expectedSha && sha !== expectedSha) {
        fails.push(`sha256 mismatch (${sha.slice(0, 12)})`);
      }
      note = `200 text/plain (${llmsRes.body.length}B, sha256[:12]=${sha.slice(0, 12)})`;
    }
    checks.push(
      makeCheck({
        id: "http_llms_txt",
        group: "http_security",
        status: fails.length === 0 ? "PASS" : "FAIL",
        elapsedMs: llmsRes.elapsedMs || 0,
        note: fails.length === 0 ? note : fails.join("; "),
      }),
    );
  }

  // 5b. /helper/extension-version.json runtime SSOT contract
  let discoveredExtVersionMeta = null;
  {
    const fails = [];
    let note = "";
    if (extVerRes.error) {
      fails.push(sanitizeText(extVerRes.error.message));
    } else {
      if (extVerRes.status !== 200) fails.push(`HTTP ${extVerRes.status}`);
      const xfo = (extVerRes.headers["x-frame-options"] || "").toUpperCase();
      if (xfo !== "DENY") fails.push(`X-Frame-Options=${xfo || "missing"}`);
      const cc = (extVerRes.headers["cache-control"] || "").toLowerCase();
      if (!cc.includes("no-cache")) fails.push(`Cache-Control=${cc || "missing"}`);
      const ct = (extVerRes.headers["content-type"] || "").toLowerCase();
      if (!ct.includes("application/json")) fails.push(`Content-Type=${ct || "missing"}`);
      const bodySha = crypto.createHash("sha256").update(extVerRes.body).digest("hex");
      const expectedJsonSha =
        manifestData?.frontend_dist_files?.["helper/extension-version.json"];
      if (expectedJsonSha && bodySha !== expectedJsonSha) {
        fails.push(`json sha256 mismatch (${bodySha.slice(0, 12)})`);
      }
      try {
        const obj = JSON.parse(extVerRes.body.toString("utf8"));
        const ver = typeof obj?.version === "string" ? obj.version.trim() : "";
        const dlUrl = typeof obj?.download_url === "string" ? obj.download_url.trim() : "";
        const zipSha = typeof obj?.sha256 === "string" ? obj.sha256.trim().toLowerCase() : "";
        if (!/^\d+\.\d+\.\d+$/.test(ver)) {
          fails.push(`invalid version=${sanitizeText(ver)}`);
        }
        if (dlUrl !== "/helper/dokitool-chrome-extension.zip") {
          fails.push("unexpected download_url");
        }
        if (zipSha && !/^[0-9a-f]{64}$/.test(zipSha)) {
          fails.push("invalid sha256 format");
        }
        const manifestZipSha =
          manifestData?.artifacts?.["dokitool-chrome-extension.zip"]?.sha256?.toLowerCase() || "";
        if (zipSha && manifestZipSha && zipSha !== manifestZipSha) {
          fails.push("extension-version.json sha256 mismatch vs release-manifest");
        }
        discoveredExtVersionMeta = { version: ver, sha256: zipSha };
        note = `v${ver || "-"}, no-cache, XFO=${xfo}${zipSha ? `, zipSha[:12]=${zipSha.slice(0, 12)}` : ""}`;
      } catch {
        fails.push("invalid JSON body");
      }
    }
    checks.push(
      makeCheck({
        id: "http_extension_version_json",
        group: "http_security",
        status: fails.length === 0 ? "PASS" : "FAIL",
        elapsedMs: extVerRes.elapsedMs || 0,
        note: fails.length === 0 ? note : fails.join("; "),
      }),
    );
  }

  // 6. True 404 (no SPA HTML fallback)
  {
    const fails = [];
    const elapsed = (missingRootRes.elapsedMs || 0) + (missingAssetRes.elapsedMs || 0);
    for (const [label, res] of [
      ["root", missingRootRes],
      ["asset", missingAssetRes],
    ]) {
      if (res.error) {
        fails.push(`${label}: ${sanitizeText(res.error.message)}`);
      } else {
        if (res.status !== 404) fails.push(`${label} HTTP ${res.status} (expected 404)`);
        const bodyLower = res.body.toString("utf8").toLowerCase();
        if (bodyLower.includes("<html") || bodyLower.includes("<!doctype html")) {
          fails.push(`${label} returned HTML fallback on 404`);
        }
      }
    }
    checks.push(
      makeCheck({
        id: "http_true_404",
        group: "http_security",
        status: fails.length === 0 ? "PASS" : "FAIL",
        elapsedMs: elapsed,
        note:
          fails.length === 0
            ? "unknown root & missing /assets/* return true 404 (non-HTML)"
            : fails.join("; "),
      }),
    );
  }

  // 7. /api/stats anonymous 401
  {
    const fails = [];
    if (statsRes.error) {
      fails.push(sanitizeText(statsRes.error.message));
    } else {
      if (statsRes.status !== 401) fails.push(`HTTP ${statsRes.status} (expected 401)`);
      const ct = (statsRes.headers["content-type"] || "").toLowerCase();
      if (!ct.includes("application/json")) fails.push(`Content-Type=${ct || "missing"}`);
      if (statsRes.headers["access-control-allow-origin"]) {
        fails.push("unexpected Access-Control-Allow-Origin on /api/stats");
      }
      try {
        const obj = JSON.parse(statsRes.body.toString("utf8"));
        if (obj?.code !== "INVALID_INPUT") {
          fails.push(`unexpected code=${sanitizeText(obj?.code)}`);
        }
      } catch {
        fails.push("invalid JSON body");
      }
    }
    checks.push(
      makeCheck({
        id: "http_api_stats_unauth",
        group: "http_security",
        status: fails.length === 0 ? "PASS" : "FAIL",
        elapsedMs: statsRes.elapsedMs || 0,
        note:
          fails.length === 0
            ? "anonymous /api/stats rejected with 401 application/json (no ACAO)"
            : fails.join("; "),
      }),
    );
  }

  return {
    checks,
    workerBuild: discoveredWorkerBuild,
    extensionVersionMeta: discoveredExtVersionMeta,
  };
}

async function runPureWebChromeChecks({ pool, target, expectedWorkerBuild, timeoutMs }) {
  const checks = [];
  const chrome = await pool.launch({ name: "pure-web" });
  const page = await createPageSession(chrome);

  try {
    // 1. Homepage hydration, theme bootstrap, zero CSP/console/page errors
    const homeStart = Date.now();
    const homeFails = [];
    let homeSummary = "";
    try {
      await page.navigate(`${target.origin}/`, timeoutMs);
      const state = await until(
        async () =>
          page.evaluate(`(() => {
            const app = document.getElementById('app');
            const input = document.querySelector('input[data-initial-url]');
            const themeScript = document.getElementById('dokitool-theme-bootstrap');
            const colorScheme = document.documentElement.style.colorScheme || '';
            const btns = Array.from(document.querySelectorAll('button'));
            const parseBtn = btns.find((b) =>
              b.classList.contains('parse-state-btn') ||
              b.getAttribute('data-stage2-parse-btn') === 'true' ||
              (input && b.closest('div') && b.closest('div').contains(input))
            );
            const ready = Boolean(app && app.childElementCount > 0 && input && !input.disabled && parseBtn && !parseBtn.disabled);
            if (!ready) return null;
            return {
              hasThemeBootstrap: Boolean(themeScript),
              colorScheme,
              darkClass: document.documentElement.classList.contains('dark'),
              title: document.title,
            };
          })()`),
        "homepage hydration",
        timeoutMs,
      );
      const errs = await page.collectErrors();
      if (!state.colorScheme && !state.hasThemeBootstrap) {
        homeFails.push("theme bootstrap not detected");
      }
      if (errs.csp.length > 0) {
        homeFails.push(`CSP violations=${errs.csp.length} (${errs.csp.map((c) => c.directive).join(",")})`);
      }
      if (errs.consoleErrors.length > 0) {
        homeFails.push(`console errors=${errs.consoleErrors.length}: ${errs.consoleErrors[0]}`);
      }
      if (errs.pageErrors.length > 0) {
        homeFails.push(`page errors=${errs.pageErrors.length}: ${errs.pageErrors[0]}`);
      }
      homeSummary = `hydrated=true, themeBootstrap=${state.hasThemeBootstrap}, colorScheme=${state.colorScheme || "unset"}, csp=0, consoleErr=0, pageErr=0`;
    } catch (err) {
      homeFails.push(sanitizeText(err.message));
    }
    checks.push(
      makeCheck({
        id: "web_home_hydration",
        group: "pure_web_chrome",
        status: homeFails.length === 0 ? "PASS" : "FAIL",
        elapsedMs: Date.now() - homeStart,
        note: homeFails.length === 0 ? homeSummary : homeFails.join("; "),
      }),
    );

    // 2. Service Worker { scope: '/downloads/', type: 'module' } + /downloads/bridge.html iframe ping
    const swStart = Date.now();
    const swFails = [];
    let swSummary = "";
    try {
      await page.resetAllErrors();
      const swResult = await page.evaluate(
        `(async () => {
          if (!('serviceWorker' in navigator)) {
            throw new Error('navigator.serviceWorker unavailable');
          }
          const reg = await navigator.serviceWorker.register('/downloads/worker.js', {
            scope: '/downloads/',
            type: 'module',
          });
          const active = await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('SW activation timeout')), 12000);
            const check = () => {
              if (reg.active && reg.active.state === 'activated') {
                clearTimeout(timer);
                resolve(reg.active);
                return true;
              }
              return false;
            };
            if (check()) return;
            const candidate = reg.installing || reg.waiting || reg.active;
            if (candidate) {
              candidate.addEventListener('statechange', () => { check(); });
            }
            reg.addEventListener('updatefound', () => {
              const nw = reg.installing;
              if (nw) nw.addEventListener('statechange', () => { check(); });
            });
          });

          const iframe = document.createElement('iframe');
          iframe.hidden = true;
          iframe.referrerPolicy = 'no-referrer';
          iframe.src = '/downloads/bridge.html';
          try {
            await new Promise((resolve, reject) => {
              const timer = setTimeout(() => reject(new Error('bridge iframe load timeout')), 8000);
              iframe.addEventListener('load', () => { clearTimeout(timer); resolve(); }, { once: true });
              iframe.addEventListener('error', () => { clearTimeout(timer); reject(new Error('bridge iframe load error')); }, { once: true });
              document.body.appendChild(iframe);
            });
            const bridgeEl = iframe.contentDocument && iframe.contentDocument.getElementById('dokitool-download-bridge');
            if (!bridgeEl) throw new Error('bridge iframe missing #dokitool-download-bridge');
            const controller = iframe.contentWindow && iframe.contentWindow.navigator.serviceWorker.controller;
            if (!controller || controller.state !== 'activated') {
              throw new Error('bridge iframe is not controlled by active download worker');
            }
            const expectedScript = new URL('/downloads/worker.js', location.origin).href;
            if (controller.scriptURL !== expectedScript) {
              throw new Error('bridge controller scriptURL mismatch');
            }
            const reply = await new Promise((resolve, reject) => {
              const timer = setTimeout(() => reject(new Error('SW MessageChannel ping timeout')), 8000);
              const chan = new iframe.contentWindow.MessageChannel();
              chan.port1.onmessage = (ev) => {
                clearTimeout(timer);
                chan.port1.close();
                resolve(ev.data);
              };
              controller.postMessage({ protocol: 1, action: 'ping' }, [chan.port2]);
            });
            return {
              scope: new URL(reg.scope).pathname,
              workerState: active.state,
              bridgeControlled: true,
              protocol: reply && reply.protocol,
              workerBuild: (reply && reply.workerBuild) || '',
              admission: Boolean(reply && reply.capabilities && reply.capabilities.admission),
            };
          } finally {
            iframe.remove();
          }
        })()`,
      );
      if (swResult.protocol !== 1) {
        swFails.push(`unexpected SW protocol=${swResult.protocol}`);
      }
      if (!swResult.workerBuild) {
        swFails.push("missing workerBuild in SW ping reply");
      }
      if (expectedWorkerBuild && swResult.workerBuild !== expectedWorkerBuild) {
        swFails.push(
          `workerBuild mismatch (http=${expectedWorkerBuild}, sw=${swResult.workerBuild})`,
        );
      }
      const errs = await page.collectErrors();
      if (errs.csp.length > 0) swFails.push(`CSP violations=${errs.csp.length}`);
      if (errs.consoleErrors.length > 0) {
        swFails.push(`console errors=${errs.consoleErrors.length}`);
      }
      if (errs.pageErrors.length > 0) {
        swFails.push(`page errors=${errs.pageErrors.length}`);
      }
      swSummary = `scope=${swResult.scope}, bridgeControlled=true, workerBuild=${swResult.workerBuild}, admission=${swResult.admission}`;
    } catch (err) {
      swFails.push(sanitizeText(err.message));
    }
    checks.push(
      makeCheck({
        id: "web_sw_bridge",
        group: "pure_web_chrome",
        status: swFails.length === 0 ? "PASS" : "FAIL",
        elapsedMs: Date.now() - swStart,
        note: swFails.length === 0 ? swSummary : swFails.join("; "),
      }),
    );

    // 3. /monitor desktop (1440x900) + mobile (390x844) zero horizontal overflow & zero CSP/errors
    const monStart = Date.now();
    const monFails = [];
    let monSummary = "";
    try {
      await page.send("Emulation.setDeviceMetricsOverride", {
        width: 1440,
        height: 900,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await page.navigate(`${target.origin}/monitor`, timeoutMs);
      const desktop = await until(
        async () =>
          page.evaluate(`(() => {
            const app = document.getElementById('app');
            if (!app || app.childElementCount === 0) return null;
            return {
              scrollWidth: document.documentElement.scrollWidth,
              innerWidth: window.innerWidth,
              overflow: document.documentElement.scrollWidth - window.innerWidth,
            };
          })()`),
        "/monitor desktop render",
        timeoutMs,
      );
      if (desktop.overflow > 1) {
        monFails.push(
          `desktop overflow=${desktop.overflow}px (${desktop.scrollWidth}>${desktop.innerWidth})`,
        );
      }

      await page.send("Emulation.setDeviceMetricsOverride", {
        width: 390,
        height: 844,
        deviceScaleFactor: 2,
        mobile: true,
      });
      await page.evaluate(
        "new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))",
      );
      const mobile = await page.evaluate(`({
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
        overflow: document.documentElement.scrollWidth - window.innerWidth,
      })`);
      if (mobile.overflow > 1) {
        monFails.push(
          `mobile 390x844 overflow=${mobile.overflow}px (${mobile.scrollWidth}>${mobile.innerWidth})`,
        );
      }

      const errs = await page.collectErrors();
      if (errs.csp.length > 0) {
        monFails.push(`CSP violations=${errs.csp.length} (${errs.csp.map((c) => c.directive).join(",")})`);
      }
      if (errs.consoleErrors.length > 0) {
        monFails.push(`console errors=${errs.consoleErrors.length}: ${errs.consoleErrors[0]}`);
      }
      if (errs.pageErrors.length > 0) {
        monFails.push(`page errors=${errs.pageErrors.length}: ${errs.pageErrors[0]}`);
      }

      monSummary = `desktop(1440x900) overflow=${desktop.overflow}px, mobile(390x844) overflow=${mobile.overflow}px, csp=0, consoleErr=0, pageErr=0`;
    } catch (err) {
      monFails.push(sanitizeText(err.message));
    }
    checks.push(
      makeCheck({
        id: "web_monitor_responsive",
        group: "pure_web_chrome",
        status: monFails.length === 0 ? "PASS" : "FAIL",
        elapsedMs: Date.now() - monStart,
        note: monFails.length === 0 ? monSummary : monFails.join("; "),
      }),
    );

    return {
      checks,
      browserVersion: chrome.versionInfo?.product || "",
    };
  } finally {
    page.dispose();
  }
}

async function runExtensionChromeChecks({
  pool,
  target,
  extDir,
  archiveInfo,
  profile,
  withMuxSave,
  samples,
  timeoutMs,
  parsePacingMs,
}) {
  const checks = [];
  const downloadDir = withMuxSave
    ? path.join(pool.tmpRoot, "ext-downloads")
    : null;
  const chrome = await pool.launch({
    name: "official-ext",
    extensionDir: extDir,
    expectedExtensionId: archiveInfo.extensionId,
    downloadDir,
  });
  const page = await createPageSession(chrome);

  try {
    // 1. Official extension handshake check (lite + full)
    const extStart = Date.now();
    const extFails = [];
    let extSummary = "";
    try {
      await page.navigate(`${target.origin}/`, timeoutMs);
      await until(
        async () =>
          page.evaluate(`Boolean(
            document.getElementById('app')?.childElementCount > 0 &&
            document.querySelector('input[data-initial-url]') &&
            !document.querySelector('input[data-initial-url]').disabled
          )`),
        "extension page ready",
        timeoutMs,
      );

      const pingRes = await until(
        async () =>
          page.evaluate(`new Promise((resolve) => {
            const rt = window.chrome && window.chrome.runtime;
            if (!rt || typeof rt.sendMessage !== 'function') {
              resolve(null);
              return;
            }
            let settled = false;
            const done = (val) => { if (!settled) { settled = true; resolve(val); } };
            const timer = setTimeout(() => done(null), 1500);
            try {
              const maybePromise = rt.sendMessage(${JSON.stringify(archiveInfo.extensionId)}, { type: 'WEB_EXT_PING' }, (resp) => {
                clearTimeout(timer);
                if (rt.lastError || !resp || !resp.ok) { done(null); return; }
                done(resp);
              });
              if (maybePromise && typeof maybePromise.then === 'function') {
                maybePromise.then((resp) => {
                  clearTimeout(timer);
                  done(resp && resp.ok ? resp : null);
                }, () => { clearTimeout(timer); done(null); });
              }
            } catch {
              clearTimeout(timer);
              done(null);
            }
          })`),
        "WEB_EXT_PING handshake",
        Math.min(timeoutMs, 15_000),
      );

      const pingData = pingRes?.data || {};
      if (pingData.version !== archiveInfo.version) {
        extFails.push(
          `WEB_EXT_PING version mismatch (expected=${archiveInfo.version}, actual=${sanitizeText(pingData.version)})`,
        );
      }
      if (pingData.extensionId !== archiveInfo.extensionId) {
        extFails.push(
          `WEB_EXT_PING extensionId mismatch (actual=${sanitizeText(pingData.extensionId)})`,
        );
      }
      const caps = Array.isArray(pingData.capabilities) ? pingData.capabilities : [];
      for (const reqCap of EXPECTED_BRIDGE_CAPABILITIES) {
        if (!caps.includes(reqCap)) {
          extFails.push(`missing capability: ${reqCap}`);
        }
      }

      const domCheck = await page.evaluate(`(() => {
        const header = document.querySelector('header');
        const headerText = header ? (header.textContent || '') : '';
        const updateBadge = document.querySelector('[data-testid="extension-update-badge"]');
        return {
          hasYtHelperGlobal: Boolean(window.__DOKITOOL_YT_HELPER__),
          hasUpdateBadgeEl: Boolean(updateBadge),
          headerHasNewVersionText: /有新版|Update v\\d/i.test(headerText),
        };
      })()`);

      if (domCheck.hasYtHelperGlobal) {
        extFails.push("unexpected window.__DOKITOOL_YT_HELPER__ truthy (userscript present)");
      }
      if (domCheck.hasUpdateBadgeEl || domCheck.headerHasNewVersionText) {
        extFails.push("unexpected outdated extension notice in top bar");
      }

      const errs = await page.collectErrors();
      if (errs.csp.length > 0) {
        extFails.push(`CSP violations=${errs.csp.length}`);
      }
      if (errs.consoleErrors.length > 0) {
        extFails.push(`console errors=${errs.consoleErrors.length}: ${errs.consoleErrors[0]}`);
      }
      if (errs.pageErrors.length > 0) {
        extFails.push(`page errors=${errs.pageErrors.length}: ${errs.pageErrors[0]}`);
      }

      extSummary = `WEB_EXT_PING ok (v${pingData.version}, id=${pingData.extensionId}, caps=${caps.join(",")}, loader=${chrome.extensionLoadMethod}), noUpdateNotice=true, ytHelperGlobal=false, csp=0, consoleErr=0, pageErr=0`;
    } catch (err) {
      extFails.push(sanitizeText(err.message));
    }

    checks.push(
      makeCheck({
        id: "ext_bridge_handshake",
        group: "official_extension_chrome",
        status: extFails.length === 0 ? "PASS" : "FAIL",
        elapsedMs: Date.now() - extStart,
        note: extFails.length === 0 ? extSummary : extFails.join("; "),
      }),
    );

    if (profile !== "full") {
      return {
        checks,
        browserVersion: chrome.versionInfo?.product || "",
      };
    }

    // 2. Full profile: live parse Bilibili -> wait >= 8.5s -> live parse YouTube (zero Tampermonkey)
    const runLiveParse = async ({ id, expectedPlatform, sampleUrl, waitBudgetMs }) => {
      const started = Date.now();
      const fails = [];
      let mediaHosts = [];
      let summary = "";
      let primaryHasMuxAttr = false;

      try {
        await page.resetAllErrors();
        const submitted = await page.evaluate(`(() => {
          const input = document.querySelector('input[data-initial-url]');
          if (!input) return { ok: false, reason: 'missing input[data-initial-url]' };
          const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
          if (nativeSetter) nativeSetter.call(input, ${JSON.stringify(sampleUrl)});
          else input.value = ${JSON.stringify(sampleUrl)};
          input.dispatchEvent(new Event('input', { bubbles: true }));
          const btn = document.querySelector('.parse-state-btn, .error-state-btn') ||
            Array.from(document.querySelectorAll('button')).find((b) =>
              b.closest('div')?.contains(input) && !b.disabled
            );
          if (!btn || btn.disabled) return { ok: false, reason: 'parse button missing or disabled' };
          btn.click();
          return { ok: true };
        })()`);
        if (!submitted?.ok) {
          throw new Stage2Error(submitted?.reason || "failed to submit parse");
        }

        const readResultSnapshot = () =>
          page.evaluate(`(() => {
              const loading = Boolean(document.querySelector('[data-cancel-parse="true"]'));
              if (loading) return null;
              const errEl = document.querySelector('.parse-error-panel');
              if (errEl) {
                return { kind: 'error', message: (errEl.textContent || '').trim().slice(0, 200) };
              }
              const badge = document.querySelector('[data-testid="result-platform-badge"]');
              const platform = badge?.getAttribute('data-platform') || '';
              if (platform !== ${JSON.stringify(expectedPlatform)}) return null;
              const extBadge = document.querySelector('[data-testid="extension-connected-badge"]');
              const updateBadge = document.querySelector('[data-testid="extension-update-badge"]');
              const ytAlert = document.querySelector('.rs-yt-helper-alert');
              const primaryBtn = document.querySelector('button.rs-btn--primary');
              const mediaUrls = [];
              for (const el of document.querySelectorAll('section.rs video[src], section.rs audio[src], section.rs img[src]')) {
                const s = el.getAttribute('src');
                if (s) mediaUrls.push(s);
              }
              return {
                kind: 'ready',
                platform,
                hasExtConnectedBadge: Boolean(extBadge),
                hasUpdateBadge: Boolean(updateBadge),
                hasYtAlert: Boolean(ytAlert),
                hasPrimaryBtn: Boolean(primaryBtn),
                primaryDisabled: primaryBtn ? Boolean(primaryBtn.disabled) : true,
                primaryLabel: primaryBtn ? (primaryBtn.textContent || '').trim() : '',
                hasDashMuxAttr: Boolean(primaryBtn?.hasAttribute('data-extension-dash-mux-save')),
                hasYtMuxAttr: Boolean(primaryBtn?.hasAttribute('data-youtube-mux-save')),
                hasYtHelperGlobal: Boolean(window.__DOKITOOL_YT_HELPER__),
                mediaHosts: mediaUrls.map((u) => {
                  try { return new URL(u, location.origin).hostname; } catch { return ''; }
                }).filter(Boolean),
              };
            })()`);

        let outcome = await until(
          readResultSnapshot,
          `${expectedPlatform} live parse`,
          waitBudgetMs,
        );

        // ResultSection lazy-loads extensionBridge and runs pingInstalledExtension() on mount;
        // allow a brief settle window for the connected badge & auto-upgraded mux CTA to render.
        if (outcome.kind === "ready" && !outcome.hasExtConnectedBadge) {
          const settled = await until(
            async () => {
              const snap = await readResultSnapshot();
              return snap && snap.kind === "ready" && snap.hasExtConnectedBadge
                ? snap
                : null;
            },
            `${expectedPlatform} extension-connected-badge settle`,
            5000,
          ).catch(() => null);
          if (settled) outcome = settled;
        }

        if (outcome.kind === "error") {
          fails.push(`parse error panel: ${sanitizeText(outcome.message)}`);
        } else {
          mediaHosts = outcome.mediaHosts || [];
          primaryHasMuxAttr = Boolean(outcome.hasDashMuxAttr || outcome.hasYtMuxAttr);
          if (!outcome.hasExtConnectedBadge) {
            fails.push("missing extension-connected-badge");
          }
          if (outcome.hasUpdateBadge) {
            fails.push("unexpected extension-update-badge");
          }
          if (outcome.hasYtAlert) {
            fails.push("unexpected youtube helper alert");
          }
          if (!outcome.hasPrimaryBtn || outcome.primaryDisabled) {
            fails.push("primary download button missing or disabled");
          }
          if (outcome.hasYtHelperGlobal) {
            fails.push("unexpected window.__DOKITOOL_YT_HELPER__ truthy");
          }
          const errs = await page.collectErrors();
          if (errs.csp.length > 0) fails.push(`CSP violations=${errs.csp.length}`);
          if (errs.consoleErrors.length > 0) {
            fails.push(`console errors=${errs.consoleErrors.length}: ${errs.consoleErrors[0]}`);
          }
          if (errs.pageErrors.length > 0) {
            fails.push(`page errors=${errs.pageErrors.length}: ${errs.pageErrors[0]}`);
          }
          summary = `platform=${outcome.platform}, extBadge=true, primaryBtn=enabled (${sanitizeText(outcome.primaryLabel)}), muxAttr=${primaryHasMuxAttr}, ytHelperGlobal=false, csp=0`;
        }
      } catch (err) {
        fails.push(sanitizeText(err.message));
      }

      const check = makeCheck({
        id,
        group: "full_live_parse",
        status: fails.length === 0 ? "PASS" : "FAIL",
        elapsedMs: Date.now() - started,
        mediaHostnames: mediaHosts,
        note: fails.length === 0 ? summary : fails.join("; "),
      });
      checks.push(check);
      return { check, completedAt: Date.now(), primaryHasMuxAttr };
    };

    const biliRes = await runLiveParse({
      id: "full_parse_bilibili",
      expectedPlatform: "bilibili",
      sampleUrl: samples.bilibiliUrl,
      waitBudgetMs: Math.max(timeoutMs, 45_000),
    });

    // Enforce >= 8.5s pacing before YouTube parse so anonymous rate limit is never tripped.
    const elapsedSinceBili = Date.now() - biliRes.completedAt;
    if (elapsedSinceBili < parsePacingMs) {
      await delay(parsePacingMs - elapsedSinceBili);
    }

    const ytRes = await runLiveParse({
      id: "full_parse_youtube",
      expectedPlatform: "youtube",
      sampleUrl: samples.youtubeUrl,
      waitBudgetMs: Math.max(timeoutMs, 60_000),
    });

    if (withMuxSave) {
      const muxStart = Date.now();
      const muxFails = [];
      let muxSummary = "";
      try {
        // Trigger primary download on current result (YouTube mux if available, else current enabled primary btn).
        const clicked = await page.evaluate(
          `(() => {
            const btn = document.querySelector('button.rs-btn--primary:not([disabled])');
            if (!btn) return { ok: false, reason: 'no enabled primary download button' };
            btn.click();
            return {
              ok: true,
              label: (btn.textContent || '').trim(),
              muxAttr: Boolean(btn.hasAttribute('data-youtube-mux-save') || btn.hasAttribute('data-extension-dash-mux-save')),
            };
          })()`,
          { userGesture: true },
        );
        if (!clicked?.ok) {
          throw new Stage2Error(clicked?.reason || "failed to click primary download");
        }

        const savedFile = await until(
          async () => {
            const files = await fsp.readdir(downloadDir).catch(() => []);
            const ready = files.filter(
              (f) => !f.endsWith(".crdownload") && !f.endsWith(".tmp") && !f.startsWith("."),
            );
            for (const f of ready) {
              const full = path.join(downloadDir, f);
              const st = await fsp.stat(full).catch(() => null);
              if (st && st.isFile() && st.size > 1024) {
                return { filename: f, fullPath: full, size: st.size };
              }
            }
            return null;
          },
          "Mediabunny mux download file on disk",
          120_000,
        );

        const stem = path.basename(savedFile.filename, path.extname(savedFile.filename));
        if (UUID_36_RE.test(stem)) {
          muxFails.push("saved filename fell back to a 36-char UUID");
        }
        const fh = await fsp.open(savedFile.fullPath, "r");
        const headerBuf = Buffer.alloc(16);
        try {
          await fh.read(headerBuf, 0, 16, 0);
        } finally {
          await fh.close();
        }
        const isMp4 = headerBuf.subarray(4, 8).toString("ascii") === "ftyp";
        const isEbml =
          headerBuf[0] === 0x1a &&
          headerBuf[1] === 0x45 &&
          headerBuf[2] === 0xdf &&
          headerBuf[3] === 0xa3;
        if (!isMp4 && !isEbml) {
          muxFails.push("saved file lacks valid MP4/WebM container magic");
        }
        const errs = await page.collectErrors();
        if (errs.csp.length > 0) muxFails.push(`CSP violations=${errs.csp.length}`);
        if (errs.consoleErrors.length > 0) {
          muxFails.push(`console errors=${errs.consoleErrors.length}`);
        }
        if (errs.pageErrors.length > 0) {
          muxFails.push(`page errors=${errs.pageErrors.length}`);
        }
        const ext = path.extname(savedFile.filename) || "(none)";
        muxSummary = `saved=${savedFile.size}B, ext=${ext}, container=${isMp4 ? "mp4(ftyp)" : "ebml"}, nonUuidFilename=true, csp=0`;
      } catch (err) {
        muxFails.push(sanitizeText(err.message));
      }

      checks.push(
        makeCheck({
          id: "full_mux_save",
          group: "full_live_parse",
          status: muxFails.length === 0 ? "PASS" : "FAIL",
          elapsedMs: Date.now() - muxStart,
          note: muxFails.length === 0 ? muxSummary : muxFails.join("; "),
        }),
      );
    }

    return {
      checks,
      browserVersion: chrome.versionInfo?.product || "",
      biliOk: biliRes.check.status === "PASS",
      ytOk: ytRes.check.status === "PASS",
    };
  } finally {
    page.dispose();
  }
}

// ============================================================================
// Report Rendering (Fail-Closed Redaction Enforced)
// ============================================================================

function escapeMdCell(text) {
  return String(text || "")
    .replaceAll("|", "\\|")
    .replace(/\r?\n/g, " ")
    .trim();
}

export function renderJsonReport(report, options = {}) {
  const rendered = JSON.stringify(report, null, 2) + "\n";
  verifyRedactedOutput(rendered, options);
  return rendered;
}

export function renderMarkdownReport(report, options = {}) {
  const summary = report.summary;
  const env = report.environment || {};
  const releaseTag = report.release_tag || "<RELEASE_TAG>";
  const shortSha = report.source_sha ? report.source_sha.slice(0, 7) : "<SHORT_SHA>";
  const totalSec = (Number(report.elapsed_ms || 0) / 1000).toFixed(2);
  const flagsStr = (env.headless_flags || MANDATORY_HEADLESS_FLAGS).join(" ");

  const lines = [
    `## 发布回执（阶段二：无头静默浏览器复测） — \`${escapeMdCell(releaseTag)}\` (\`${escapeMdCell(shortSha)}\`)`,
    "",
    `- **目标站点**: \`${escapeMdCell(report.target_host)}\` | **风险档位**: \`${escapeMdCell(report.profile)}\` (\`--skip-http-checks=${Boolean(report.skip_http_checks)}\`) | **生成时间 (UTC)**: \`${escapeMdCell(report.generated_at_utc)}\` | **总耗时**: \`${totalSec}s\``,
    `- **执行环境**: \`${escapeMdCell(env.platform || process.platform)}/${escapeMdCell(env.arch || process.arch)} | ${escapeMdCell(env.browser_version || "Chrome")} (${escapeMdCell(flagsStr)}) | Official Extension v${escapeMdCell(env.extension_version || "-")} (id=${escapeMdCell(env.extension_id || DOKITOOL_EXTENSION_ID)}, diff: 0, zero Tampermonkey)\``,
    `- **网络与资源清理**: \`proxy=${escapeMdCell(env.proxy_mode || "direct")} (no-credentials) | RESIDUAL_CHROME=${Number(env.residual_chrome ?? 0)} | 脱敏扫描: ${Number(report.redaction_scan?.sensitive_items ?? 0)} 敏感项\``,
    `- **汇总**: \`PASS=${summary.pass}, FAIL=${summary.fail}, SKIP=${summary.skip}\``,
    "",
    "| 检查项 (`id`) | 分组 (`group`) | 结论 (`status`) | 耗时 (ms) | 媒体域名 (`media_hostnames`) | 关键核对摘要 (`note`) |",
    "| --- | --- | --- | ---: | --- | --- |",
  ];

  for (const item of report.checks) {
    const hostsCell =
      item.media_hostnames && item.media_hostnames.length > 0
        ? item.media_hostnames.map((h) => `\`${escapeMdCell(h)}\``).join(", ")
        : "-";
    lines.push(
      `| \`${escapeMdCell(item.id)}\` | \`${escapeMdCell(item.group)}\` | **${escapeMdCell(item.status)}** | ${item.elapsed_ms} | ${hostsCell} | ${escapeMdCell(item.note)} |`,
    );
  }

  const rendered = lines.join("\n") + "\n";
  verifyRedactedOutput(rendered, options);
  return rendered;
}

// ============================================================================
// Orchestrator & CLI
// ============================================================================

async function loadManifestIfProvided(manifestPath) {
  if (!manifestPath) return null;
  let raw;
  try {
    raw = await fsp.readFile(manifestPath, "utf8");
  } catch {
    throw new Stage2Error("failed to read --manifest file");
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Stage2Error("invalid --manifest JSON");
  }
  if (!data || typeof data !== "object") {
    throw new Stage2Error("invalid --manifest: root must be a JSON object");
  }
  return data;
}

async function loadFullSamples(options) {
  let bilibiliUrl = options.bilibiliUrl || "";
  let youtubeUrl = options.youtubeUrl || "";

  if (!bilibiliUrl || !youtubeUrl) {
    const samplesPath = options.samplesPath || DEFAULT_SAMPLES_PATH;
    try {
      const raw = JSON.parse(await fsp.readFile(samplesPath, "utf8"));
      if (!bilibiliUrl) bilibiliUrl = String(raw?.platforms?.bilibili?.url || "");
      if (!youtubeUrl) youtubeUrl = String(raw?.platforms?.youtube?.url || "");
    } catch {
      throw new Stage2Error("failed to load samples.json for --profile full");
    }
  }

  for (const [label, val] of [
    ["bilibili", bilibiliUrl],
    ["youtube", youtubeUrl],
  ]) {
    let parsed;
    try {
      parsed = new URL(val);
    } catch {
      throw new Stage2Error(`invalid ${label} sample URL`);
    }
    if (
      (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
      parsed.username ||
      parsed.password
    ) {
      throw new Stage2Error(`unsafe ${label} sample URL`);
    }
  }

  return { bilibiliUrl, youtubeUrl };
}

export async function runStage2(options = {}) {
  const startedAt = Date.now();
  const profile = options.profile || DEFAULT_PROFILE;
  if (!VALID_PROFILES.includes(profile)) {
    throw new Stage2Error(
      `invalid --profile: expected one of ${VALID_PROFILES.join("|")}`,
    );
  }
  if (options.withMuxSave && profile !== "full") {
    throw new Stage2Error("--with-mux-save requires --profile full");
  }

  const target = validateBaseUrl(options.baseUrl || DEFAULT_BASE_URL);
  const proxyConfig = resolveProxyConfig({
    cliProxy: options.proxy || "",
    env: options.env || process.env,
    target,
  });
  const timeoutMs = Math.max(
    1000,
    Number(options.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS) * 1000,
  );
  const parsePacingMs = Math.max(
    0,
    Number(options.parsePacingMs ?? DEFAULT_PARSE_PACING_MS),
  );

  // Validate --sync-local-extension up front (fail-closed before launching Chrome).
  if (options.syncLocalExtension) {
    if (!options.manifestPath) {
      throw new Stage2Error(
        "--sync-local-extension requires --manifest for release digest verification",
      );
    }
    assertPathNotGitTracked(options.syncLocalExtension);
  }

  const chromeInfo = discoverChromeBinary({
    cliChromeBin: options.chromeBin || "",
    env: options.env || process.env,
  });
  if (!chromeInfo) {
    throw new Stage2Error(
      "unable to locate Chrome/Chromium executable (set DOKITOOL_CHROME_BIN or --chrome-bin)",
    );
  }

  const manifestData = await loadManifestIfProvided(options.manifestPath);
  const fullSamples =
    profile === "full" ? await loadFullSamples(options) : null;

  const client = new OriginHttpClient({
    target,
    proxyConfig,
    timeoutMs,
  });
  const pool = new ChromeProcessPool(chromeInfo.path, proxyConfig);
  await pool.init();

  return _executeTracks({
    startedAt,
    profile,
    target,
    proxyConfig,
    timeoutMs,
    parsePacingMs,
    manifestData,
    fullSamples,
    client,
    pool,
    options,
  });
}

async function _executeTracks({
  startedAt,
  profile,
  target,
  proxyConfig,
  timeoutMs,
  parsePacingMs,
  manifestData,
  fullSamples,
  client,
  pool,
  options,
}) {
  const onSignal = async (signal) => {
    await pool.cleanupAll();
    process.exit(signal === "SIGTERM" ? 143 : 130);
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  let checks = [];
  let browserVersion = "";
  let extensionVersion = "";
  let extensionId = DOKITOOL_EXTENSION_ID;
  let residualChrome = 0;

  try {
    // Track 1: HTTP security & static artifact checks (concurrent at t=0)
    const httpTrack = runHttpChecks({
      client,
      target,
      manifestData,
      skipHttpChecks: Boolean(options.skipHttpChecks),
    });

    // Track 2: Pure Web headless Chrome instance (concurrent at t=0; cross-checks workerBuild after join)
    const pureWebTrack = runPureWebChromeChecks({
      pool,
      target,
      expectedWorkerBuild: "",
      timeoutMs,
    });

    // Track 3: Extension ZIP verify + unpack -> Official Extension Chrome (+ optional sync & full parse)
    const extTrack = (async () => {
      const zipStart = Date.now();
      let archiveInfo = null;
      const zipFails = [];
      let zipNote = "";

      try {
        const zipRes = await client.get("/helper/dokitool-chrome-extension.zip");
        if (zipRes.status !== 200) {
          throw new Stage2Error(`HTTP ${zipRes.status} fetching extension ZIP`);
        }
        archiveInfo = validateExtensionArchive(zipRes.body, {
          target,
          manifestData,
          expectedExtVersion: options.expectedExtVersion || "",
          expectedExtFiles: options.expectedExtFiles ?? null,
        });
        extensionVersion = archiveInfo.version;
        extensionId = archiveInfo.extensionId;
        zipNote = `size=${archiveInfo.sizeBytes}B, sha256[:12]=${archiveInfo.sha256.slice(0, 12)}, files=${archiveInfo.fileCount}, v${archiveInfo.version}, id=${archiveInfo.extensionId}, manifestMatch=${archiveInfo.manifestVerifiedAgainstRelease}, zeroContentScripts=true, zeroCookies=true`;
      } catch (err) {
        zipFails.push(sanitizeText(err.message));
      }

      const extChecks = [
        makeCheck({
          id: "artifact_extension_zip",
          group: "artifact_verify",
          status: zipFails.length === 0 ? "PASS" : "FAIL",
          elapsedMs: Date.now() - zipStart,
          note: zipFails.length === 0 ? zipNote : zipFails.join("; "),
        }),
      ];

      if (!archiveInfo) {
        extChecks.push(
          makeCheck({
            id: "ext_bridge_handshake",
            group: "official_extension_chrome",
            status: "FAIL",
            note: "aborted: official extension archive verification failed",
          }),
        );
        return { checks: extChecks, browserVersion: "" };
      }

      if (pool.closing) {
        throw new Stage2Error("ChromeProcessPool is shutting down");
      }
      const extDir = path.join(pool.tmpRoot, "ext-unpacked");
      await extractZipEntriesToDir(archiveInfo.entries, extDir);
      if (pool.closing) {
        if (pool.tmpRoot) {
          await fsp.rm(pool.tmpRoot, { recursive: true, force: true }).catch(() => {});
        }
        throw new Stage2Error("ChromeProcessPool is shutting down");
      }

      // Run Extension Chrome verification FIRST, then sync locally ONLY if all Chrome checks pass.
      const chromeRes = await runExtensionChromeChecks({
        pool,
        target,
        extDir,
        archiveInfo,
        profile,
        withMuxSave: Boolean(options.withMuxSave),
        samples: fullSamples,
        timeoutMs,
        parsePacingMs,
      });

      if (options.syncLocalExtension && !pool.closing) {
        const syncStart = Date.now();
        const chromePassed = chromeRes.checks.every((c) => c.status !== "FAIL");
        if (!chromePassed) {
          extChecks.push(
            makeCheck({
              id: "sync_local_extension",
              group: "artifact_verify",
              status: "FAIL",
              elapsedMs: Date.now() - syncStart,
              note: "aborted: official extension Chrome verification failed",
            }),
          );
        } else {
          try {
            const res = await syncExtensionAtomic(
              archiveInfo,
              options.syncLocalExtension,
            );
            extChecks.push(
              makeCheck({
                id: "sync_local_extension",
                group: "artifact_verify",
                status: "PASS",
                elapsedMs: Date.now() - syncStart,
                note: `atomic sync ok (files=${res.fileCount}, v${res.version}, sha256[:12]=${res.sha256.slice(0, 12)})`,
              }),
            );
          } catch (err) {
            extChecks.push(
              makeCheck({
                id: "sync_local_extension",
                group: "artifact_verify",
                status: "FAIL",
                elapsedMs: Date.now() - syncStart,
                note: sanitizeText(err.message),
              }),
            );
          }
        }
      }

      extChecks.push(...chromeRes.checks);
      return {
        checks: extChecks,
        browserVersion: chromeRes.browserVersion,
        archiveInfo,
      };
    })();

    const [httpSettled, pureWebSettled, extSettled] = await Promise.allSettled([
      httpTrack,
      pureWebTrack,
      extTrack,
    ]);
    const firstRejected = [httpSettled, pureWebSettled, extSettled].find(
      (res) => res.status === "rejected",
    );
    if (firstRejected) {
      throw firstRejected.reason;
    }
    const httpRes = httpSettled.value;
    const pureWebRes = pureWebSettled.value;
    const extRes = extSettled.value;

    // Cross-verify SW workerBuild against HTTP /downloads/worker.js BUILD when both ran.
    if (httpRes.workerBuild) {
      const swCheck = pureWebRes.checks.find((c) => c.id === "web_sw_bridge");
      if (
        swCheck &&
        swCheck.status === "PASS" &&
        !swCheck.note.includes(`workerBuild=${httpRes.workerBuild}`)
      ) {
        swCheck.status = "FAIL";
        swCheck.note = sanitizeText(
          `${swCheck.note}; mismatch vs HTTP BUILD=${httpRes.workerBuild}`,
        );
      }
    }

    // Cross-verify /helper/extension-version.json against downloaded extension archive when both ran.
    if (httpRes.extensionVersionMeta && extRes.archiveInfo) {
      const verCheck = httpRes.checks.find((c) => c.id === "http_extension_version_json");
      if (verCheck && verCheck.status === "PASS") {
        const mismatches = [];
        if (httpRes.extensionVersionMeta.version !== extRes.archiveInfo.version) {
          mismatches.push(
            `version mismatch (json=${httpRes.extensionVersionMeta.version}, zip=${extRes.archiveInfo.version})`,
          );
        }
        if (
          httpRes.extensionVersionMeta.sha256 &&
          httpRes.extensionVersionMeta.sha256 !== extRes.archiveInfo.sha256
        ) {
          mismatches.push("sha256 mismatch vs downloaded extension zip");
        }
        if (mismatches.length > 0) {
          verCheck.status = "FAIL";
          verCheck.note = sanitizeText(`${verCheck.note}; ${mismatches.join("; ")}`);
        }
      }
    }

    browserVersion = pureWebRes.browserVersion || extRes.browserVersion || "";
    checks = [...extRes.checks.slice(0, 1), ...httpRes.checks, ...pureWebRes.checks, ...extRes.checks.slice(1)];
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    client.close();
    const cleanRes = await pool.cleanupAll();
    residualChrome = cleanRes.residualChrome;
  }

  if (residualChrome > 0) {
    checks.push(
      makeCheck({
        id: "process_cleanup",
        group: "cleanup",
        status: "FAIL",
        note: `RESIDUAL_CHROME=${residualChrome} (expected 0)`,
      }),
    );
  }

  const summary = {
    total: checks.length,
    pass: checks.filter((c) => c.status === "PASS").length,
    fail: checks.filter((c) => c.status === "FAIL").length,
    skip: checks.filter((c) => c.status === "SKIP").length,
  };

  return {
    schema_version: SCHEMA_VERSION,
    tool: "stage2_browser",
    profile,
    skip_http_checks: Boolean(options.skipHttpChecks),
    release_tag: manifestData?.release_tag ? sanitizeText(manifestData.release_tag) : "",
    source_sha: manifestData?.source_sha ? sanitizeText(manifestData.source_sha) : "",
    generated_at_utc: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    target_host: target.targetHost,
    elapsed_ms: Math.max(0, Date.now() - startedAt),
    passed: summary.fail === 0 && residualChrome === 0,
    environment: {
      platform: process.platform,
      arch: process.arch,
      browser_version: sanitizeText(browserVersion),
      headless_flags: [...MANDATORY_HEADLESS_FLAGS],
      proxy_mode: proxyConfig.mode,
      extension_version: sanitizeText(extensionVersion),
      extension_id: sanitizeText(extensionId),
      residual_chrome: residualChrome,
    },
    redaction_scan: {
      passed: true,
      sensitive_items: 0,
    },
    summary,
    checks,
  };
}

export function parseCliArgs(argv) {
  const opts = {
    baseUrl: DEFAULT_BASE_URL,
    profile: DEFAULT_PROFILE,
    manifestPath: "",
    samplesPath: DEFAULT_SAMPLES_PATH,
    bilibiliUrl: "",
    youtubeUrl: "",
    skipHttpChecks: false,
    withMuxSave: false,
    syncLocalExtension: "",
    chromeBin: "",
    proxy: "",
    expectedExtVersion: "",
    expectedExtFiles: null,
    timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
    jsonOut: "",
    mdOut: "",
    format: "both",
    help: false,
  };

  const requireValue = (flag, idx) => {
    if (idx + 1 >= argv.length) {
      throw new Stage2Error(`missing value for ${flag}`);
    }
    return argv[idx + 1];
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      opts.help = true;
      continue;
    }
    if (arg === "--skip-http-checks") {
      opts.skipHttpChecks = true;
      continue;
    }
    if (arg === "--with-mux-save") {
      opts.withMuxSave = true;
      continue;
    }

    let flag = arg;
    let inlineVal = null;
    const eqIdx = arg.indexOf("=");
    if (arg.startsWith("--") && eqIdx > 2) {
      flag = arg.slice(0, eqIdx);
      inlineVal = arg.slice(eqIdx + 1);
    }

    const takeVal = () => {
      if (inlineVal !== null) return inlineVal;
      const val = requireValue(flag, i);
      i += 1;
      return val;
    };

    switch (flag) {
      case "--base-url":
        opts.baseUrl = takeVal();
        break;
      case "--profile":
        opts.profile = takeVal();
        break;
      case "--manifest":
        opts.manifestPath = takeVal();
        break;
      case "--samples":
        opts.samplesPath = takeVal();
        break;
      case "--bilibili-url":
        opts.bilibiliUrl = takeVal();
        break;
      case "--youtube-url":
        opts.youtubeUrl = takeVal();
        break;
      case "--sync-local-extension":
        opts.syncLocalExtension = takeVal();
        break;
      case "--chrome-bin":
        opts.chromeBin = takeVal();
        break;
      case "--proxy":
        opts.proxy = takeVal();
        break;
      case "--expected-ext-version":
        opts.expectedExtVersion = takeVal();
        break;
      case "--expected-ext-files": {
        const n = Number(takeVal());
        if (!Number.isInteger(n) || n < 1) {
          throw new Stage2Error("invalid --expected-ext-files: positive integer required");
        }
        opts.expectedExtFiles = n;
        break;
      }
      case "--timeout": {
        const n = Number(takeVal());
        if (!Number.isFinite(n) || n <= 0) {
          throw new Stage2Error("invalid --timeout: positive number required");
        }
        opts.timeoutSeconds = n;
        break;
      }
      case "--json-out":
        opts.jsonOut = takeVal();
        break;
      case "--md-out":
        opts.mdOut = takeVal();
        break;
      case "--format": {
        const val = takeVal();
        if (!["both", "md", "json", "none"].includes(val)) {
          throw new Stage2Error("invalid --format: expected both|md|json|none");
        }
        opts.format = val;
        break;
      }
      default:
        throw new Stage2Error(`unknown argument: ${arg}`);
    }
  }

  if (!VALID_PROFILES.includes(opts.profile)) {
    throw new Stage2Error(
      `invalid --profile: expected one of ${VALID_PROFILES.join("|")}`,
    );
  }
  if (opts.withMuxSave && opts.profile !== "full") {
    throw new Stage2Error("--with-mux-save requires --profile full");
  }
  return opts;
}

function usageText() {
  return `Usage: node scripts/prod-smoke/stage2_browser.mjs [options]

Options:
  --base-url <url>               Target origin (default: ${DEFAULT_BASE_URL})
  --profile <lite|full>          Risk profile (default: ${DEFAULT_PROFILE})
  --manifest <path>              release-manifest.json for SHA-256 verification
  --skip-http-checks             Skip HTTP header/artifact checks already verified in Stage 1
  --with-mux-save                (--profile full only) Also verify Mediabunny dual-track save
  --sync-local-extension <dir>   Atomically extract verified extension into an untracked dir
  --samples <path>               samples.json path for --profile full
  --bilibili-url <url>           Override Bilibili sample URL for --profile full
  --youtube-url <url>            Override YouTube sample URL for --profile full
  --chrome-bin <path>            Explicit Chrome/Chromium binary (overrides auto-discovery)
  --proxy <url>                  Explicit HTTP(S) proxy URL (credentials forbidden)
  --expected-ext-version <ver>   Assert exact manifest.json version
  --expected-ext-files <int>     Assert exact file count inside extension ZIP
  --timeout <seconds>            Per-step timeout in seconds (default: ${DEFAULT_TIMEOUT_SECONDS})
  --json-out <path>              Write fail-closed redacted JSON report
  --md-out <path>                Write fail-closed redacted Markdown Stage-2 receipt
  --format <both|md|json|none>   Stdout output format (default: both)
  -h, --help                     Show this help text
`;
}

async function writeUtf8File(filePath, content) {
  await fsp.mkdir(path.dirname(path.resolve(filePath)), { recursive: true });
  await fsp.writeFile(filePath, content, "utf8");
}

export async function main(argv = process.argv.slice(2)) {
  try {
    const opts = parseCliArgs(argv);
    if (opts.help) {
      process.stdout.write(usageText());
      return 0;
    }

    const report = await runStage2(opts);
    const jsonText = renderJsonReport(report);
    const mdText = renderMarkdownReport(report);

    if (opts.jsonOut) {
      await writeUtf8File(opts.jsonOut, jsonText);
    }
    if (opts.mdOut) {
      await writeUtf8File(opts.mdOut, mdText);
    }

    if (opts.format === "md") {
      process.stdout.write(mdText);
    } else if (opts.format === "json") {
      process.stdout.write(jsonText);
    } else if (opts.format === "both") {
      process.stdout.write(mdText);
      process.stdout.write("\n```json\n");
      process.stdout.write(jsonText);
      process.stdout.write("```\n");
    }

    return report.passed ? 0 : 1;
  } catch (err) {
    process.stderr.write(
      `stage2-browser error: ${sanitizeText(err?.message || String(err))}\n`,
    );
    return 1;
  }
}

const isDirectExecution =
  Boolean(process.argv[1]) &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

function flushStream(stream) {
  return new Promise((resolve) => {
    if (!stream || stream.destroyed || stream.writableEnded) {
      resolve();
      return;
    }
    let settled = false;
    const done = () => {
      if (!settled) {
        settled = true;
        resolve();
      }
    };
    const timer = setTimeout(done, 500);
    timer.unref?.();
    stream.write("", () => {
      clearTimeout(timer);
      done();
    });
  });
}

if (isDirectExecution) {
  const code = await main();
  await Promise.all([flushStream(process.stdout), flushStream(process.stderr)]);
  process.exit(code);
}
