// L2 Real-Extension & Service-Worker Headless E2E Regression Suite (Node 22/24 stdlib only).
//
// Zero external network access (all mock production origins are terminated through an
// isolated loopback HTTP CONNECT + ephemeral TLS server trusted via SPKI pin).
// Always runs Chrome strictly headless (`--headless=new --no-first-run
// --no-default-browser-check --use-mock-keychain --password-store=basic`) and guarantees
// zero residual child processes on exit.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash, createPublicKey } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";
import { connect, until } from "./download-browser-session.mjs";
import { discoverChromeBinary } from "./prod-smoke/stage2_browser.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const DEFAULT_DIST_DIR = path.join(REPO_ROOT, "frontend", "dist");
const DEFAULT_EXT_DIR = path.join(REPO_ROOT, "frontend", "dist-extension");
const FIXTURES_DIR = path.join(
  REPO_ROOT,
  "frontend",
  "tests",
  "fixtures",
  "download",
);
const EXTENSION_META = JSON.parse(
  fs.readFileSync(
    path.join(REPO_ROOT, "frontend", "src", "core", "extensionReleaseMeta.json"),
    "utf8",
  ),
);
const DOKITOOL_EXTENSION_ID = EXTENSION_META.extensionId;
const EXPECTED_TAMPER_WARNING_FRAGMENT = "检测到浏览器内其他下载类扩展改写了保存文件名";

const MOCK_ALLOWED_HOSTS = new Set([
  "snap.dokitool.com",
  "rr1---sn-e2e.googlevideo.com",
  "upos-sz-mirrorcos.bilivideo.com",
  "v26-default.toutiaovod.com",
  "tbvideo.ixiaochuan.cn",
  "sns-webpic-qc.xhscdn.com",
  "sns-video-bd.xhscdn.com",
]);
const UNWHITELISTED_HOST = "cdn.unlisted-generic.example";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function padMp4WithFreeBox(buf, padBytes) {
  let ftypEnd = 0;
  for (let off = 0; off + 8 <= buf.length; ) {
    const size = buf.readUInt32BE(off);
    const type = buf.toString("ascii", off + 4, off + 8);
    if (size < 8) break;
    if (type === "ftyp") {
      ftypEnd = off + size;
      break;
    }
    off += size;
  }
  if (!ftypEnd) throw new Error("MP4 fixture missing ftyp box");
  const freeBuf = Buffer.alloc(padBytes);
  freeBuf.writeUInt32BE(padBytes, 0);
  freeBuf.write("free", 4, "ascii");
  const rest = Buffer.from(buf.subarray(ftypEnd));
  // Shift every `stco` chunk offset inside `moov` by +padBytes so Mediabunny demuxes cleanly.
  for (let i = 0; i + 16 <= rest.length; i++) {
    if (
      rest[i + 4] === 0x73 &&
      rest[i + 5] === 0x74 &&
      rest[i + 6] === 0x63 &&
      rest[i + 7] === 0x6f
    ) {
      const boxSize = rest.readUInt32BE(i);
      const count = rest.readUInt32BE(i + 12);
      if (boxSize === 16 + count * 4) {
        for (let k = 0; k < count; k++) {
          const oldOff = rest.readUInt32BE(i + 16 + k * 4);
          rest.writeUInt32BE(oldOff + padBytes, i + 16 + k * 4);
        }
        break;
      }
    }
  }
  return Buffer.concat([buf.subarray(0, ftypEnd), freeBuf, rest]);
}

function parseZipEntries(zipBuf) {
  assert.ok(
    zipBuf.length >= 22 &&
      zipBuf[0] === 0x50 &&
      zipBuf[1] === 0x4b &&
      zipBuf[2] === 0x03 &&
      zipBuf[3] === 0x04,
    "ZIP file must start with PKZIP magic 504b0304",
  );
  // Locate End of Central Directory (0x06054b50)
  let eocdOff = -1;
  for (let i = zipBuf.length - 22; i >= Math.max(0, zipBuf.length - 65557); i--) {
    if (zipBuf.readUInt32LE(i) === 0x06054b50) {
      eocdOff = i;
      break;
    }
  }
  assert.ok(eocdOff >= 0, "ZIP missing EOCD record");
  const entryCount = zipBuf.readUInt16LE(eocdOff + 10);
  const cdOffset = zipBuf.readUInt32LE(eocdOff + 16);

  const entries = new Map();
  let off = cdOffset;
  for (let i = 0; i < entryCount; i++) {
    assert.equal(zipBuf.readUInt32LE(off), 0x02014b50, "Invalid ZIP central header");
    const method = zipBuf.readUInt16LE(off + 10);
    const compSize = zipBuf.readUInt32LE(off + 20);
    const nameLen = zipBuf.readUInt16LE(off + 28);
    const extraLen = zipBuf.readUInt16LE(off + 30);
    const commentLen = zipBuf.readUInt16LE(off + 32);
    const localOff = zipBuf.readUInt32LE(off + 42);
    const name = zipBuf.subarray(off + 46, off + 46 + nameLen).toString("utf8");
    off += 46 + nameLen + extraLen + commentLen;

    assert.equal(zipBuf.readUInt32LE(localOff), 0x04034b50, "Invalid ZIP local header");
    const lNameLen = zipBuf.readUInt16LE(localOff + 26);
    const lExtraLen = zipBuf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const raw = zipBuf.subarray(dataStart, dataStart + compSize);
    const data = method === 0 ? raw : method === 8 ? zlib.inflateRawSync(raw) : null;
    assert.ok(data, `Unsupported ZIP compression method ${method} for ${name}`);
    entries.set(name, data);
  }
  return entries;
}

async function generateEphemeralTlsCert(tlsDir) {
  await fsp.mkdir(tlsDir, { recursive: true });
  const keyPath = path.join(tlsDir, "e2e-key.pem");
  const certPath = path.join(tlsDir, "e2e-cert.pem");
  const cfgPath = path.join(tlsDir, "openssl.cnf");
  const sanEntries = [
    ...Array.from(MOCK_ALLOWED_HOSTS).map((h) => `DNS:${h}`),
    `DNS:${UNWHITELISTED_HOST}`,
    "IP:127.0.0.1",
  ].join(",");
  await fsp.writeFile(
    cfgPath,
    [
      "[req]",
      "distinguished_name = dn",
      "x509_extensions = v3_req",
      "prompt = no",
      "[dn]",
      "CN = snap.dokitool.com",
      "[v3_req]",
      "basicConstraints = CA:FALSE",
      "keyUsage = digitalSignature, keyEncipherment",
      "extendedKeyUsage = serverAuth",
      `subjectAltName = ${sanEntries}`,
      "",
    ].join("\n"),
    "utf8",
  );
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:prime256v1",
      "-nodes",
      "-days",
      "1",
      "-keyout",
      keyPath,
      "-out",
      certPath,
      "-config",
      cfgPath,
    ],
    { stdio: "pipe" },
  );
  const [keyPem, certPem] = await Promise.all([
    fsp.readFile(keyPath, "utf8"),
    fsp.readFile(certPath, "utf8"),
  ]);
  const spkiDer = createPublicKey(certPem).export({
    type: "spki",
    format: "der",
  });
  const spkiHash = createHash("sha256").update(spkiDer).digest("base64");
  return { keyPem, certPem, spkiHash };
}

async function createIsolatedMockInfrastructure({ runDir, distDir }) {
  const [avcMp4, audioM4a, sampleJpg, catalogJson] = await Promise.all([
    fsp.readFile(path.join(FIXTURES_DIR, "one-frame-avc.mp4")),
    fsp.readFile(path.join(FIXTURES_DIR, "one-frame-audio.m4a")),
    fsp.readFile(path.join(FIXTURES_DIR, "sample.jpg")),
    fsp.readFile(
      path.join(REPO_ROOT, "frontend", "src", "generated", "platform-catalog.json"),
    ),
  ]);
  // ~1.1 MiB valid H.264 MP4 (ftyp + free + mdat + moov) -> spans chunk 0 (512 KiB) & chunk 1 (>512 KiB)
  const paddedYouTubeMp4 = padMp4WithFreeBox(avcMp4, 1_100_000);
  const { keyPem, certPem, spkiHash } = await generateEphemeralTlsCert(
    path.join(runDir, "tls"),
  );

  const state = {
    workerVersionOverride: null, // null -> real dist worker.js, string -> patched BUILD for SW upgrade test
    proxyHits: new Map(),
    biliRequests: [],
    relayRequests: [],
    ytChunkRequests: 0,
    unwhitelistedHttpRequests: 0,
  };

  function serveByteRange(req, res, buffer, extraHeaders = {}, options = {}) {
    const total = buffer.length;
    const reqUrl = new URL(req.url, "https://mock.local");
    const queryRange = reqUrl.searchParams.get("range");
    const headerRange = req.headers.range;
    let start = 0;
    let end = total - 1;
    let isPartial = false;

    if (queryRange && /^\d+-\d+$/.test(queryRange)) {
      const [s, e] = queryRange.split("-").map(Number);
      start = Math.max(0, Math.min(s, total - 1));
      end = Math.max(start, Math.min(e, total - 1));
      isPartial = true;
    } else if (typeof headerRange === "string") {
      const m = /^bytes=(\d+)-(\d*)$/i.exec(headerRange.trim());
      if (m) {
        start = Number(m[1]);
        end = m[2] ? Math.min(Number(m[2]), total - 1) : total - 1;
        isPartial = true;
      }
    }

    const slice = buffer.subarray(start, end + 1);
    const headers = {
      "Accept-Ranges": "bytes",
      "Cache-Control": "no-store",
      "Content-Length": String(slice.length),
      ...extraHeaders,
    };
    if (isPartial) {
      headers["Content-Range"] = `bytes ${start}-${end}/${total}`;
    }
    const status = options.force200 ? 200 : isPartial ? 206 : 200;
    res.writeHead(status, headers);

    if (options.throttleSlices && slice.length > 65_536) {
      // Stream in multiple timed slices so ReadableStream onprogress emits >=10 smooth increments.
      const sliceCount = options.throttleSlices;
      const pieceLen = Math.max(4096, Math.ceil(slice.length / sliceCount));
      let offset = 0;
      const sendNext = () => {
        if (res.destroyed || res.writableEnded) return;
        const nextEnd = Math.min(slice.length, offset + pieceLen);
        res.write(slice.subarray(offset, nextEnd));
        offset = nextEnd;
        if (offset >= slice.length) {
          res.end();
        } else {
          setTimeout(sendNext, options.sliceDelayMs ?? 155);
        }
      };
      sendNext();
    } else {
      res.end(slice);
    }
  }

  const mimeMap = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".mjs": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".woff2": "font/woff2",
    ".txt": "text/plain; charset=utf-8",
  };

  const httpsServer = https.createServer(
    { key: keyPem, cert: certPem },
    async (req, res) => {
      const host = String(req.headers.host || "")
        .split(":")[0]
        .toLowerCase();
      const url = new URL(req.url || "/", `https://${host || "snap.dokitool.com"}`);

      if (host === UNWHITELISTED_HOST) {
        state.unwhitelistedHttpRequests += 1;
        res.writeHead(403).end("unwhitelisted forbidden");
        return;
      }

      // 1. Mock YouTube googlevideo CDN
      if (host === "rr1---sn-e2e.googlevideo.com" && url.pathname === "/videoplayback") {
        const itag = url.searchParams.get("itag");
        state.ytChunkRequests += 1;
        if (itag === "299") {
          return serveByteRange(
            req,
            res,
            paddedYouTubeMp4,
            {
              "Content-Type": "video/mp4",
              "Access-Control-Allow-Origin": "*",
            },
            { force200: true, throttleSlices: 16, sliceDelayMs: 210 },
          );
        }
        if (itag === "140") {
          return serveByteRange(
            req,
            res,
            audioM4a,
            {
              "Content-Type": "audio/mp4",
              "Access-Control-Allow-Origin": "*",
            },
            { force200: true },
          );
        }
        return res.writeHead(404).end();
      }

      // 2. Mock Bilibili DASH CDN (verifies MV3 DNR Referer injection & zero Cookie)
      if (host === "upos-sz-mirrorcos.bilivideo.com") {
        state.biliRequests.push({
          path: url.pathname,
          referer: req.headers.referer || null,
          origin: req.headers.origin || null,
          cookie: req.headers.cookie || null,
        });
        const isAudio = url.pathname.includes("audio");
        return serveByteRange(req, res, isAudio ? audioM4a : avcMp4, {
          "Content-Type": isAudio ? "audio/mp4" : "video/mp4",
          "Access-Control-Allow-Origin": "*",
        });
      }

      // 3. Mock Toutiao CORS-blocked extensionless CDN (deliberately omits ACAO!)
      if (host === "v26-default.toutiaovod.com") {
        return serveByteRange(req, res, avcMp4, {
          "Content-Type": "video/mp4",
        });
      }

      // 4. Mock Zuiyou tbvideo CDN
      if (host === "tbvideo.ixiaochuan.cn") {
        return serveByteRange(req, res, avcMp4, {
          "Content-Type": "video/mp4",
        });
      }

      // 5. Mock Xiaohongshu album & live-photo CDNs
      if (host === "sns-webpic-qc.xhscdn.com") {
        return serveByteRange(req, res, sampleJpg, {
          "Content-Type": "image/jpeg",
          "Access-Control-Allow-Origin": "*",
        });
      }
      if (host === "sns-video-bd.xhscdn.com") {
        return serveByteRange(req, res, avcMp4, {
          "Content-Type": "video/mp4",
          "Access-Control-Allow-Origin": "*",
        });
      }

      // 6. Mock snap.dokitool.com primary origin
      if (host === "snap.dokitool.com") {
        if (url.pathname === "/api/platforms") {
          return res
            .writeHead(200, { "Content-Type": "application/json; charset=utf-8" })
            .end(catalogJson);
        }

        if (url.pathname === "/api/media/weibo") {
          state.relayRequests.push({
            path: url.pathname,
            ticket: url.searchParams.get("ticket") || "",
            cookie: req.headers.cookie || null,
          });
          return serveByteRange(req, res, avcMp4, {
            "Content-Type": "video/mp4",
          });
        }

        if (url.pathname === "/api/parse") {
          const inputUrl = url.searchParams.get("url") || "";
          if (inputUrl.includes("toutiao.com")) {
            return res
              .writeHead(200, { "Content-Type": "application/json; charset=utf-8" })
              .end(
                JSON.stringify({
                  schema_version: "1.0",
                  code: "OK",
                  data: {
                    platform: "toutiao",
                    platform_name: "今日头条",
                    content_id: "7501991960077500979",
                    title: "深海科考实录片段",
                    source_url: inputUrl,
                    default_item_id: "tt-e2e-1",
                    items: [
                      {
                        id: "tt-e2e-1",
                        index: 0,
                        type: "video",
                        state: "ready",
                        default: {
                          variant_id: "tt-1080p",
                          source_id: "s-tt",
                          url: "https://v26-default.toutiaovod.com/e2e/stream-no-ext",
                        },
                        variants: [
                          {
                            id: "tt-1080p",
                            label: "1080p",
                            state: "ready",
                            metadata: {
                              width: 1920,
                              height: 1080,
                              extension: "mp4",
                              container: "mp4",
                              mime_type: "video/mp4",
                              has_audio: true,
                              evidence: "upstream",
                            },
                            delivery: {
                              kind: "file",
                              sources: [
                                {
                                  id: "s-tt",
                                  url: "https://v26-default.toutiaovod.com/e2e/stream-no-ext",
                                  size_bytes: avcMp4.length,
                                },
                              ],
                            },
                          },
                        ],
                      },
                    ],
                  },
                }),
              );
          }
          if (inputUrl.includes("xiaochuankeji.cn") || inputUrl.includes("izuiyou.com")) {
            return res
              .writeHead(200, { "Content-Type": "application/json; charset=utf-8" })
              .end(
                JSON.stringify({
                  schema_version: "1.0",
                  code: "OK",
                  data: {
                    platform: "zuiyou",
                    platform_name: "最右",
                    content_id: "163566379",
                    title: "最右宠物实测视频",
                    source_url: inputUrl,
                    default_item_id: "zy-e2e-1",
                    items: [
                      {
                        id: "zy-e2e-1",
                        index: 0,
                        type: "video",
                        state: "ready",
                        tbvideo: {
                          download_hint: true,
                          url: "https://tbvideo.ixiaochuan.cn/zy/e2e-tbvideo.mp4",
                        },
                        default: {
                          variant_id: "zy-720p",
                          source_id: "s-zy",
                          url: "https://tbvideo.ixiaochuan.cn/zy/e2e-tbvideo.mp4",
                        },
                        variants: [
                          {
                            id: "zy-720p",
                            label: "720p",
                            state: "ready",
                            metadata: {
                              width: 720,
                              height: 1280,
                              extension: "mp4",
                              container: "mp4",
                              mime_type: "video/mp4",
                              has_audio: true,
                              evidence: "upstream",
                            },
                            delivery: {
                              kind: "file",
                              sources: [
                                {
                                  id: "s-zy",
                                  url: "https://tbvideo.ixiaochuan.cn/zy/e2e-tbvideo.mp4",
                                  size_bytes: avcMp4.length,
                                },
                              ],
                            },
                          },
                        ],
                      },
                    ],
                  },
                }),
              );
          }
          return res.writeHead(404).end();
        }

        if (url.pathname === "/downloads/worker.js") {
          const workerPath = path.join(distDir, "downloads", "worker.js");
          let text = await fsp.readFile(workerPath, "utf8");
          if (state.workerVersionOverride) {
            text = text.replace(
              /const BUILD = "[^"]+"/,
              `const BUILD = "${state.workerVersionOverride}"`,
            );
          }
          return res
            .writeHead(200, {
              "Content-Type": "application/javascript; charset=utf-8",
              "Cache-Control": "no-store",
              "Service-Worker-Allowed": "/downloads/",
            })
            .end(text);
        }

        // Serve static files from frontend/dist
        const rel = url.pathname === "/" ? "/index.html" : url.pathname;
        const abs = path.resolve(distDir, "." + rel);
        if (!abs.startsWith(path.resolve(distDir) + path.sep)) {
          return res.writeHead(404).end();
        }
        try {
          const body = await fsp.readFile(abs);
          const ext = path.extname(abs).toLowerCase();
          return res
            .writeHead(200, {
              "Content-Type": mimeMap[ext] || "application/octet-stream",
              "Cache-Control": "no-store",
            })
            .end(body);
        } catch (err) {
          if (err && err.code === "ENOENT") return res.writeHead(404).end();
          throw err;
        }
      }

      res.writeHead(404).end();
    },
  );

  await new Promise((resolve, reject) =>
    httpsServer.once("error", reject).listen(0, "127.0.0.1", resolve),
  );
  const httpsPort = httpsServer.address().port;

  // Local zero-egress HTTP CONNECT proxy -> tunnels ONLY MOCK_ALLOWED_HOSTS to httpsServer
  const proxyServer = http.createServer((_req, res) => {
    res.writeHead(403).end("Direct HTTP proxying disabled");
  });
  proxyServer.on("connect", (req, clientSocket, head) => {
    const rawAuthority = String(req.url || "");
    const targetHost = rawAuthority.split(":")[0].toLowerCase();
    state.proxyHits.set(targetHost, (state.proxyHits.get(targetHost) || 0) + 1);

    if (!MOCK_ALLOWED_HOSTS.has(targetHost)) {
      clientSocket.write(
        "HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
      );
      clientSocket.destroy();
      return;
    }

    const upstream = net.connect(httpsPort, "127.0.0.1", () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head && head.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on("error", () => clientSocket.destroy());
    clientSocket.on("error", () => upstream.destroy());
  });

  await new Promise((resolve, reject) =>
    proxyServer.once("error", reject).listen(0, "127.0.0.1", resolve),
  );
  const proxyPort = proxyServer.address().port;

  return {
    fixtures: { avcMp4, audioM4a, sampleJpg, paddedYouTubeMp4 },
    spkiHash,
    proxyPort,
    state,
    async close() {
      proxyServer.closeAllConnections?.();
      httpsServer.closeAllConnections?.();
      await Promise.all([
        new Promise((r) => proxyServer.close(() => r())),
        new Promise((r) => httpsServer.close(() => r())),
      ]);
    },
  };
}

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

async function settleWithin(promise, timeoutMs) {
  let timer;
  try {
    await Promise.race([
      Promise.resolve(promise).catch(() => {}),
      new Promise((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export class HeadlessChromeManager {
  constructor({
    chromeBin,
    proxyPort,
    spkiHash,
    tempDirs = [],
    onBeforeExit = null,
  }) {
    this.chromeBin = chromeBin;
    this.proxyPort = proxyPort;
    this.spkiHash = spkiHash;
    this.instances = [];
    this.tempDirs = new Set();
    for (const dir of tempDirs) {
      this.registerTempDir(dir);
    }
    this.onBeforeExit = typeof onBeforeExit === "function" ? onBeforeExit : null;
    this.closing = false;
    this._closePromise = null;
    this._inflightLaunches = new Set();
    this._signalHandlersInstalled = false;
    this._signalTriggered = false;
    this._onSignal = (signal) => {
      if (this._signalTriggered) return;
      this._signalTriggered = true;
      void (async () => {
        try {
          await this.closeAll();
          if (this.onBeforeExit) {
            await this.onBeforeExit().catch(() => {});
          }
        } finally {
          process.exit(signal === "SIGTERM" ? 143 : 130);
        }
      })();
    };
  }

  registerTempDir(dir) {
    if (typeof dir === "string" && dir.trim()) {
      this.tempDirs.add(path.resolve(dir));
    }
  }

  installSignalHandlers() {
    if (this._signalHandlersInstalled) return;
    this._signalHandlersInstalled = true;
    process.once("SIGINT", this._onSignal);
    process.once("SIGTERM", this._onSignal);
  }

  disposeSignalHandlers() {
    if (!this._signalHandlersInstalled) return;
    this._signalHandlersInstalled = false;
    process.off("SIGINT", this._onSignal);
    process.off("SIGTERM", this._onSignal);
  }

  async launch(opts) {
    if (this.closing) {
      throw new Error("HeadlessChromeManager is shutting down");
    }
    this.installSignalHandlers();
    const pending = this.#launchInternal(opts);
    this._inflightLaunches.add(pending);
    try {
      return await pending;
    } finally {
      this._inflightLaunches.delete(pending);
    }
  }

  async #launchInternal({ profileDir, downloadDir, extensionDirs = [] }) {
    this.registerTempDir(profileDir);
    await fsp.mkdir(path.join(profileDir, "Default"), { recursive: true });
    if (downloadDir) {
      this.registerTempDir(downloadDir);
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

    if (this.closing) {
      throw new Error("HeadlessChromeManager is shutting down");
    }

    const args = [
      "--headless=new",
      "--no-first-run",
      "--no-default-browser-check",
      "--use-mock-keychain",
      "--password-store=basic",
      "--disable-background-networking",
      "--disable-sync",
      "--disable-default-apps",
      "--disable-component-update",
      "--no-pings",
      "--mute-audio",
      "--window-size=1440,900",
      "--remote-debugging-port=0",
      `--user-data-dir=${profileDir}`,
      `--proxy-server=http://127.0.0.1:${this.proxyPort}`,
      `--ignore-certificate-errors-spki-list=${this.spkiHash}`,
    ];

    const supportsCliLoadExtension =
      /chrome for testing|chromium|ms-playwright/i.test(this.chromeBin);
    if (extensionDirs.length > 0) {
      args.push("--enable-unsafe-extension-debugging");
      if (supportsCliLoadExtension) {
        const joined = extensionDirs.join(",");
        args.push(`--disable-extensions-except=${joined}`, `--load-extension=${joined}`);
      }
    }
    args.push("about:blank");

    const stderrBuf = [];
    const child = spawn(this.chromeBin, args, {
      detached: process.platform !== "win32",
      stdio: ["ignore", "ignore", "pipe"],
    });
    child.stderr?.on("data", (chunk) => {
      if (stderrBuf.length < 32) stderrBuf.push(chunk.toString("utf8"));
    });

    const record = {
      child,
      pid: child.pid,
      browser: null,
      profileDir,
      downloadDir: downloadDir || null,
      exited: false,
      _killPromise: null,
    };
    let spawnError = null;
    child.once("error", (err) => {
      spawnError = err;
      record.exited = true;
    });
    child.once("exit", () => {
      record.exited = true;
    });
    this.instances.push(record);

    if (this.closing) {
      await this.killInstance(record);
      throw new Error("HeadlessChromeManager is shutting down");
    }

    try {
      const activePortFile = path.join(profileDir, "DevToolsActivePort");
      await until(
        async () => {
          if (this.closing) {
            throw new Error("HeadlessChromeManager is shutting down");
          }
          if (spawnError) {
            throw new Error(`Chrome failed to spawn: ${spawnError.message}`);
          }
          if (record.exited || child.exitCode !== null) {
            throw new Error(
              `Chrome exited prematurely (${child.exitCode}): ${stderrBuf.join("").slice(0, 400)}`,
            );
          }
          try {
            const text = await fsp.readFile(activePortFile, "utf8");
            return text.trim().split(/\r?\n/).length >= 2;
          } catch {
            return false;
          }
        },
        "Chrome DevToolsActivePort",
        20_000,
      );

      const browser = await connect(profileDir);
      record.browser = browser;
      if (this.closing) {
        throw new Error("HeadlessChromeManager is shutting down");
      }
      // NOTE: Never call `Browser.setDownloadBehavior({ behavior: "allow" })` when testing
      // `chrome.downloads` extensions because CDP's `allow` mode short-circuits
      // `ChromeDownloadManagerDelegate` and replaces filenames with random GUIDs (bypassing
      // both `filename` subdirectories and `onDeterminingFilename` listeners).
      // `Default/Preferences` (`download.default_directory`) configures Chrome's real download
      // manager natively in `--headless=new` for both extension and page/SW downloads.

      // Ensure every requested extension is loaded in exact order (needed on branded Chrome 137+).
      if (extensionDirs.length > 0 && !supportsCliLoadExtension) {
        for (const extDir of extensionDirs) {
          await browser.send("Extensions.loadUnpacked", { path: extDir });
          await delay(150);
        }
      }

      if (this.closing) {
        throw new Error("HeadlessChromeManager is shutting down");
      }

      const attach = async (targetId) =>
        (await browser.send("Target.attachToTarget", { targetId, flatten: true }))
          .sessionId;
      const evaluate = async (sessionId, expression, userGesture = false) => {
        const reply = await browser.send(
          "Runtime.evaluate",
          { expression, awaitPromise: true, returnByValue: true, userGesture },
          sessionId,
        );
        if (reply.exceptionDetails) {
          throw new Error(
            reply.exceptionDetails.exception?.description ||
              reply.exceptionDetails.text ||
              "Runtime.evaluate exception",
          );
        }
        return reply.result?.value;
      };

      return { record, browser, attach, evaluate };
    } catch (err) {
      await this.killInstance(record);
      throw err;
    }
  }

  killInstance(record) {
    if (!record) return Promise.resolve();
    return (record._killPromise ??= this.#doKillInstance(record));
  }

  async #doKillInstance(record) {
    try {
      if (record.browser) {
        await settleWithin(record.browser.send("Browser.close"), 1200);
        try {
          record.browser.close?.();
        } catch {}
        record.browser = null;
      }
    } catch {}
    const pid = record.pid;
    if (!pid) return;
    if (!record.exited || isPidAlive(pid)) {
      killProcessTree(pid, "SIGTERM");
      const deadline = Date.now() + 2500;
      while (!record.exited && isPidAlive(pid) && Date.now() < deadline) {
        await delay(50);
      }
      if (!record.exited || isPidAlive(pid)) {
        killProcessTree(pid, "SIGKILL");
        const killDeadline = Date.now() + 1500;
        while (isPidAlive(pid) && Date.now() < killDeadline) {
          await delay(50);
        }
      }
    }
    try {
      record.child?.stderr?.destroy();
      record.child?.unref?.();
    } catch {}
  }

  closeAll() {
    this.closing = true;
    this.disposeSignalHandlers();
    return (this._closePromise ??= this.#doCloseAll());
  }

  async #doCloseAll() {
    await Promise.all(this.instances.map((inst) => this.killInstance(inst)));

    if (this._inflightLaunches.size > 0) {
      await settleWithin(Promise.allSettled([...this._inflightLaunches]), 3000);
    }

    // Re-terminate defensively in case an in-flight launch pushed an instance before settling.
    await Promise.all(this.instances.map((inst) => this.killInstance(inst)));

    let residualPids = this.instances
      .map((inst) => inst.pid)
      .filter((pid) => isPidAlive(pid));

    if (residualPids.length > 0) {
      for (const pid of residualPids) {
        killProcessTree(pid, "SIGKILL");
      }
      await delay(300);
      residualPids = residualPids.filter((pid) => isPidAlive(pid));
    }

    for (const dir of this.tempDirs) {
      await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    }

    return residualPids.length;
  }
}

async function createConflictFixtureExtension(dir) {
  await fsp.mkdir(dir, { recursive: true });
  const manifest = {
    manifest_version: 3,
    name: "E2E Conflicting Download Manager Fixture",
    version: "1.0.0",
    permissions: ["downloads"],
    background: {
      service_worker: "background.js",
      type: "module",
    },
  };
  const backgroundJs = `
const HIJACKED_UUID = "123e4567-e89b-12d3-a456-426614174000.mp4";
chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  if (item && (String(item.url || "").startsWith("blob:") || String(item.filename || "").endsWith(".mp4"))) {
    suggest({ filename: HIJACKED_UUID, conflictAction: "uniquify" });
    return;
  }
  suggest();
});
`;
  await Promise.all([
    fsp.writeFile(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2)),
    fsp.writeFile(path.join(dir, "background.js"), backgroundJs.trimStart()),
  ]);
  return dir;
}

async function waitForFileOnDisk(filePath, minBytes = 1, budgetMs = 20_000) {
  return until(
    async () => {
      try {
        const st = await fsp.stat(filePath);
        if (st.size >= minBytes) {
          const data = await fsp.readFile(filePath);
          if (data.length >= minBytes) return data;
        }
      } catch {}
      return null;
    },
    `saved file ${path.basename(filePath)}`,
    budgetMs,
  );
}

export async function runExtensionE2E({
  runDir,
  distDir = DEFAULT_DIST_DIR,
  extDir = DEFAULT_EXT_DIR,
  chromeBin = null,
} = {}) {
  const resolvedRunDir = path.resolve(runDir);
  await fsp.mkdir(resolvedRunDir, { recursive: true });
  if (!fs.existsSync(path.join(distDir, "index.html"))) {
    throw new Error(`Missing built frontend dist at ${distDir}; run npm run build first`);
  }
  if (!fs.existsSync(path.join(extDir, "manifest.json"))) {
    throw new Error(`Missing built extension at ${extDir}; run npm run build first`);
  }

  const discovered = discoverChromeBinary({ cliChromeBin: chromeBin || undefined });
  const infra = await createIsolatedMockInfrastructure({
    runDir: resolvedRunDir,
    distDir,
  });
  const chromeMgr = new HeadlessChromeManager({
    chromeBin: discovered.path,
    proxyPort: infra.proxyPort,
    spkiHash: infra.spkiHash,
    tempDirs: [
      path.join(resolvedRunDir, "tls"),
      path.join(resolvedRunDir, "conflict-ext"),
    ],
    onBeforeExit: () => infra.close(),
  });
  chromeMgr.installSignalHandlers();

  const report = {
    startedAt: new Date().toISOString(),
    chromeSource: discovered.source,
    scenarios: {},
    residualChrome: -1,
    passed: false,
  };

  try {
    // =========================================================================
    // INSTANCE A: Real Unmodified Production Extension (`frontend/dist-extension`)
    // Covers Prototypes 1..6:
    //   1) youtube_mux (firstProgress < 2s, >=10 increments, EWMA speed > 0, close-panel keepalive)
    //   2) dash_mux (1080P lossless mux + Multi-P subfolder + MV3 DNR Referer)
    //   3) album / live_photo (ZIP 504b0304 + JPG ffd8ffe0 + MP4 ftyp)
    //   4) relay (/api/media/weibo)
    //   5) cors_blocked + tbvideo (M2/M3 silent Chinese-filename save)
    //   6) unwhitelisted generic domain zero-egress isolation
    // =========================================================================
    const dlDirA = path.join(resolvedRunDir, "downloads-ext");
    const instA = await chromeMgr.launch({
      profileDir: path.join(resolvedRunDir, "profile-ext"),
      downloadDir: dlDirA,
      extensionDirs: [extDir],
    });

    const { targetId: webTargetId } = await instA.browser.send("Target.createTarget", {
      url: "https://snap.dokitool.com/",
    });
    const webSession = await instA.attach(webTargetId);
    await until(
      () => instA.evaluate(webSession, "document.readyState === 'complete'"),
      "snap.dokitool.com loaded",
    );

    const extPing = await until(
      () =>
        instA.evaluate(
          webSession,
          `new Promise((resolve) => {
            if (!window.chrome?.runtime?.sendMessage) return resolve(null);
            chrome.runtime.sendMessage(${JSON.stringify(DOKITOOL_EXTENSION_ID)}, { type: "WEB_EXT_PING" }, (resp) => {
              if (chrome.runtime.lastError || !resp?.ok) return resolve(null);
              resolve(resp.data);
            });
          })`,
        ),
      "WEB_EXT_PING handshake",
      15_000,
    );
    assert.equal(extPing.extensionId, DOKITOOL_EXTENSION_ID);
    assert.ok(extPing.capabilities.includes("youtube_mux"));
    assert.ok(extPing.capabilities.includes("dash_mux"));
    assert.ok(extPing.capabilities.includes("direct_download"));
    report.extensionVersion = extPing.version;

    const webExtRpc = (req) =>
      instA.evaluate(
        webSession,
        `new Promise((resolve) => {
          chrome.runtime.sendMessage(${JSON.stringify(DOKITOOL_EXTENSION_ID)}, ${JSON.stringify(req)}, (resp) => {
            if (chrome.runtime.lastError) return resolve({ ok: false, error: chrome.runtime.lastError.message });
            resolve(resp);
          });
        })`,
      );

    // Open SidePanel page target (M3 context)
    const { targetId: spTargetId1 } = await instA.browser.send("Target.createTarget", {
      url: `chrome-extension://${DOKITOOL_EXTENSION_ID}/sidepanel.html`,
    });
    const spSession1 = await instA.attach(spTargetId1);
    await until(
      () =>
        instA.evaluate(
          spSession1,
          "document.readyState === 'complete' && location.protocol === 'chrome-extension:' && Boolean(globalThis.chrome?.runtime?.sendMessage)",
        ),
      "sidepanel.html loaded",
    );

    // --- Prototype 1: youtube_mux (streaming smoothness + close-panel keepalive) ---
    {
      const t0 = Date.now();
      const enq = await webExtRpc({
        type: "WEB_EXT_ENQUEUE_MEDIA",
        payload: {
          kind: "youtube_mux",
          platform: "youtube",
          title: "L2 YouTube 4K60 合流",
          filename: "L2_YouTube_4K60_合流.mp4",
          youtubeMux: {
            videoUrl: `https://rr1---sn-e2e.googlevideo.com/videoplayback?itag=299&clen=${infra.fixtures.paddedYouTubeMp4.length}`,
            audioUrl: `https://rr1---sn-e2e.googlevideo.com/videoplayback?itag=140&clen=${infra.fixtures.audioM4a.length}`,
            videoSize: infra.fixtures.paddedYouTubeMp4.length,
            audioSize: infra.fixtures.audioM4a.length,
            outputContainer: "mp4",
          },
          sizeBytes:
            infra.fixtures.paddedYouTubeMp4.length + infra.fixtures.audioM4a.length,
        },
      });
      assert.equal(enq?.ok, true, `youtube_mux enqueue failed: ${JSON.stringify(enq)}`);
      const taskId = enq.data.taskId;

      let firstProgressMs = null;
      let lastLoaded = -1;
      let monotonicIncrements = 0;
      let sawPositiveSpeed = false;
      let zeroSpeedDropsAfterStart = 0;
      let closedSidePanelMidFlight = false;
      let finalStatus = null;

      const deadline = Date.now() + 25_000;
      while (Date.now() < deadline) {
        const stResp = await webExtRpc({ type: "WEB_EXT_GET_TASK_STATUS", taskId });
        assert.equal(stResp?.ok, true, "WEB_EXT_GET_TASK_STATUS must succeed");
        const st = stResp.data;
        if (st.phase === "downloading" || st.phase === "muxing") {
          if (st.loadedBytes > 0 && firstProgressMs === null) {
            firstProgressMs = Date.now() - t0;
          }
          if (st.loadedBytes > lastLoaded) {
            if (st.loadedBytes > 0) monotonicIncrements += 1;
            lastLoaded = st.loadedBytes;
          } else {
            assert.ok(
              st.loadedBytes >= lastLoaded,
              `youtube_mux loadedBytes regressed during ${st.phase}: ${st.loadedBytes} < ${lastLoaded}`,
            );
          }
          if (st.speedBytesPerSec > 0) {
            sawPositiveSpeed = true;
          } else if (sawPositiveSpeed && st.loadedBytes > 0) {
            zeroSpeedDropsAfterStart += 1;
          }
          if (!closedSidePanelMidFlight && st.loadedBytes > 0) {
            closedSidePanelMidFlight = true;
            await instA.browser.send("Target.closeTarget", { targetId: spTargetId1 });
          }
        }
        if (["completed", "failed", "cancelled"].includes(st.phase)) {
          finalStatus = st;
          break;
        }
        await delay(100);
      }

      assert.ok(finalStatus, "youtube_mux timed out before reaching terminal state");
      assert.equal(
        finalStatus.phase,
        "completed",
        `youtube_mux failed: ${finalStatus.error || JSON.stringify(finalStatus)}`,
      );
      assert.ok(
        firstProgressMs !== null && firstProgressMs < 2000,
        `youtube_mux first progress took ${firstProgressMs}ms (must be < 2000ms)`,
      );
      assert.ok(
        monotonicIncrements >= 10,
        `youtube_mux monotonic streaming increments = ${monotonicIncrements} (must be >= 10)`,
      );
      assert.equal(sawPositiveSpeed, true, "youtube_mux must report positive smoothed speed");
      assert.equal(
        zeroSpeedDropsAfterStart,
        0,
        `youtube_mux speed dropped abnormally to 0 (${zeroSpeedDropsAfterStart} times)`,
      );
      assert.equal(
        closedSidePanelMidFlight,
        true,
        "youtube_mux test must close SidePanel mid-download to verify background keepalive",
      );

      assert.ok(
        typeof finalStatus.filename === "string" &&
          finalStatus.filename.endsWith("L2_YouTube_4K60_合流.mp4"),
        `Unexpected youtube_mux filename: ${finalStatus.filename}`,
      );
      const savedMp4 = await waitForFileOnDisk(
        path.join(dlDirA, finalStatus.filename),
        512,
      );
      assert.equal(
        savedMp4.subarray(4, 8).toString("ascii"),
        "ftyp",
        "Saved YouTube muxed MP4 must have valid ISO BMFF ftyp header",
      );
      report.scenarios.youtube_mux = {
        passed: true,
        firstProgressMs,
        monotonicIncrements,
        zeroSpeedDropsAfterStart,
        closedSidePanelKeepalive: true,
        savedBytes: savedMp4.length,
        magic: savedMp4.subarray(4, 12).toString("ascii"),
      };
    }

    // Re-open SidePanel target for M3 batch / multi-P subfolder / album ZIP / isolation checks
    const { targetId: spTargetId2 } = await instA.browser.send("Target.createTarget", {
      url: `chrome-extension://${DOKITOOL_EXTENSION_ID}/sidepanel.html`,
    });
    const spSession2 = await instA.attach(spTargetId2);
    await until(
      () =>
        instA.evaluate(
          spSession2,
          "document.readyState === 'complete' && location.protocol === 'chrome-extension:' && Boolean(globalThis.chrome?.runtime?.sendMessage)",
        ),
      "reopened sidepanel.html loaded",
    );
    const sidePanelRpc = (req) =>
      instA.evaluate(
        spSession2,
        `chrome.runtime.sendMessage(${JSON.stringify(req)})`,
      );
    const waitSidePanelTask = async (taskId, label) =>
      until(
        async () => {
          const snap = await sidePanelRpc({ type: "GET_INITIAL_STATE" });
          const t = snap?.data?.tasks?.find((x) => x.taskId === taskId);
          return t && ["completed", "failed", "cancelled"].includes(t.status) ? t : null;
        },
        label,
        20_000,
      );

    // --- Prototype 2: dash_mux (1080P lossless mux + Multi-P subfolder + MV3 DNR Referer) ---
    {
      const enq = await sidePanelRpc({
        type: "ENQUEUE_DOWNLOADS",
        groupBatchId: "bili-multi-p-e2e",
        items: [1, 2].map((p) => ({
          title: `架构演进_P${p}`,
          platform: "bilibili",
          spec: {
            kind: "dash_mux",
            apiOrigin: "https://snap.dokitool.com",
            routes: [`https://upos-sz-mirrorcos.bilivideo.com/upgcxcode/e2e/video_p${p}.m4s`],
            filename: `B站多P合集/架构演进_P${p}.mp4`,
            mimeType: "video/mp4",
            dashMux: {
              videoRoutes: [
                `https://upos-sz-mirrorcos.bilivideo.com/upgcxcode/e2e/video_p${p}.m4s`,
              ],
              audioRoutes: [
                `https://upos-sz-mirrorcos.bilivideo.com/upgcxcode/e2e/audio_p${p}.m4s`,
              ],
              videoSize: infra.fixtures.avcMp4.length,
              audioSize: infra.fixtures.audioM4a.length,
              outputContainer: "mp4",
            },
          },
        })),
      });
      assert.equal(enq?.ok, true, `dash_mux enqueue failed: ${JSON.stringify(enq)}`);
      assert.equal(enq.data.taskIds.length, 2);

      const savedSubfolderFiles = [];
      for (let i = 0; i < 2; i++) {
        const done = await waitSidePanelTask(enq.data.taskIds[i], `dash_mux P${i + 1}`);
        assert.equal(done.status, "completed", `dash_mux P${i + 1} failed: ${done.error}`);
        const relPath = path.join("B站多P合集", `架构演进_P${i + 1}.mp4`);
        const bytes = await waitForFileOnDisk(path.join(dlDirA, relPath), 512);
        assert.equal(bytes.subarray(4, 8).toString("ascii"), "ftyp");
        savedSubfolderFiles.push({ relPath, bytes: bytes.length });
      }
      assert.ok(infra.state.biliRequests.length >= 4, "Expected >= 4 Bilibili track fetches");
      assert.ok(
        infra.state.biliRequests.every(
          (r) => r.referer === "https://www.bilibili.com/" && r.cookie === null,
        ),
        `MV3 DNR must inject Bilibili Referer with zero Cookie: ${JSON.stringify(infra.state.biliRequests)}`,
      );
      report.scenarios.dash_mux = {
        passed: true,
        savedSubfolderFiles,
        dnrRefererVerified: true,
        zeroCookiesVerified: true,
      };
    }

    // --- Prototype 3: album / live_photo (ZIP 504b0304 + JPG ffd8ffe0 + MP4 ftyp) ---
    {
      const enq = await sidePanelRpc({
        type: "ENQUEUE_DOWNLOADS",
        items: [
          {
            title: "单图样本",
            platform: "xiaohongshu",
            spec: {
              kind: "direct_file",
              apiOrigin: "https://snap.dokitool.com",
              routes: ["https://sns-webpic-qc.xhscdn.com/e2e/single.jpg"],
              filename: "单图样本.jpg",
              mimeType: "image/jpeg",
            },
          },
          {
            title: "京都实况图集",
            platform: "xiaohongshu",
            spec: {
              kind: "batch_zip",
              apiOrigin: "https://snap.dokitool.com",
              routes: ["https://sns-webpic-qc.xhscdn.com/e2e/photo1.jpg"],
              filename: "京都实况图集_3P.zip",
              mimeType: "application/zip",
              zipEntries: [
                {
                  entryName: "photo_01.jpg",
                  routes: ["https://sns-webpic-qc.xhscdn.com/e2e/photo1.jpg"],
                  mimeType: "image/jpeg",
                },
                {
                  entryName: "live_02.jpg",
                  routes: ["https://sns-webpic-qc.xhscdn.com/e2e/live2.jpg"],
                  mimeType: "image/jpeg",
                },
                {
                  entryName: "live_02.mp4",
                  routes: ["https://sns-video-bd.xhscdn.com/e2e/live2.mp4"],
                  mimeType: "video/mp4",
                },
              ],
            },
          },
        ],
      });
      assert.equal(enq?.ok, true);
      const [jpgDone, zipDone] = await Promise.all([
        waitSidePanelTask(enq.data.taskIds[0], "single jpg"),
        waitSidePanelTask(enq.data.taskIds[1], "album batch_zip"),
      ]);
      assert.equal(jpgDone.status, "completed", `single jpg failed: ${jpgDone.error}`);
      assert.equal(zipDone.status, "completed", `batch_zip failed: ${zipDone.error}`);

      const jpgBytes = await waitForFileOnDisk(path.join(dlDirA, "单图样本.jpg"), 100);
      assert.equal(jpgBytes.subarray(0, 4).toString("hex"), "ffd8ffe0");
      assert.equal(sha256(jpgBytes), sha256(infra.fixtures.sampleJpg));

      const zipBytes = await waitForFileOnDisk(
        path.join(dlDirA, "京都实况图集_3P.zip"),
        100,
      );
      assert.equal(zipBytes.subarray(0, 4).toString("hex"), "504b0304");
      const entries = parseZipEntries(zipBytes);
      assert.equal(entries.size, 3);
      assert.equal(entries.get("photo_01.jpg").subarray(0, 4).toString("hex"), "ffd8ffe0");
      assert.equal(entries.get("live_02.jpg").subarray(0, 4).toString("hex"), "ffd8ffe0");
      assert.equal(entries.get("live_02.mp4").subarray(4, 8).toString("ascii"), "ftyp");

      report.scenarios.album_live_photo = {
        passed: true,
        jpgMagic: "ffd8ffe0",
        zipMagic: "504b0304",
        zipEntryCount: entries.size,
      };
    }

    // --- Prototype 4: relay (/api/media/weibo) ---
    {
      const enq = await webExtRpc({
        type: "WEB_EXT_ENQUEUE_MEDIA",
        payload: {
          kind: "direct_download",
          platform: "weibo",
          title: "微博中转实测",
          filename: "微博中转实测.mp4",
          routes: ["https://snap.dokitool.com/api/media/weibo?ticket=e2e-relay-ticket"],
          mimeType: "video/mp4",
        },
      });
      assert.equal(enq?.ok, true, `relay enqueue failed: ${JSON.stringify(enq)}`);
      const done = await waitSidePanelTask(enq.data.taskId, "relay download");
      assert.equal(done.status, "completed", `relay download failed: ${done.error}`);
      const saved = await waitForFileOnDisk(path.join(dlDirA, done.filename), 512);
      assert.ok(done.filename.endsWith("微博中转实测.mp4"), `Unexpected relay filename: ${done.filename}`);
      assert.equal(sha256(saved), sha256(infra.fixtures.avcMp4));
      assert.equal(saved.subarray(4, 8).toString("ascii"), "ftyp");
      assert.ok(
        infra.state.relayRequests.length >= 1 &&
          infra.state.relayRequests.every((r) => r.cookie === null),
        "Relay download must never transmit cookies",
      );
      report.scenarios.relay = {
        passed: true,
        savedBytes: saved.length,
        zeroCookiesVerified: true,
      };
    }

    // --- Prototype 5 (M2/M3): cors_blocked (toutiaovod) + tbvideo (zuiyou) silent Chinese save ---
    {
      const ttEnq = await webExtRpc({
        type: "WEB_EXT_ENQUEUE_MEDIA",
        payload: {
          kind: "direct_download",
          platform: "toutiao",
          title: "今日头条无水印实测",
          filename: "今日头条无水印实测.mp4",
          routes: ["https://v26-default.toutiaovod.com/e2e/stream-no-ext"],
          mimeType: "video/mp4",
        },
      });
      const zyEnq = await webExtRpc({
        type: "WEB_EXT_ENQUEUE_MEDIA",
        payload: {
          kind: "direct_download",
          platform: "zuiyou",
          title: "最右原生流实测",
          filename: "最右原生流实测.mp4",
          routes: ["https://tbvideo.ixiaochuan.cn/zy/e2e-tbvideo.mp4"],
          mimeType: "video/mp4",
        },
      });
      assert.equal(ttEnq?.ok, true);
      assert.equal(zyEnq?.ok, true);
      const [ttDone, zyDone] = await Promise.all([
        waitSidePanelTask(ttEnq.data.taskId, "toutiao M2 silent save"),
        waitSidePanelTask(zyEnq.data.taskId, "zuiyou tbvideo M2 silent save"),
      ]);
      assert.equal(ttDone.status, "completed", `toutiao failed: ${ttDone.error}`);
      assert.equal(zyDone.status, "completed", `zuiyou failed: ${zyDone.error}`);
      assert.ok(ttDone.filename.endsWith("今日头条无水印实测.mp4"), `Unexpected toutiao filename: ${ttDone.filename}`);
      assert.ok(zyDone.filename.endsWith("最右原生流实测.mp4"), `Unexpected zuiyou filename: ${zyDone.filename}`);
      const [ttBytes, zyBytes] = await Promise.all([
        waitForFileOnDisk(path.join(dlDirA, ttDone.filename), 512),
        waitForFileOnDisk(path.join(dlDirA, zyDone.filename), 512),
      ]);
      assert.equal(sha256(ttBytes), sha256(infra.fixtures.avcMp4));
      assert.equal(sha256(zyBytes), sha256(infra.fixtures.avcMp4));
      report.scenarios.cors_blocked_tbvideo_ext = {
        passed: true,
        toutiaoSavedBytes: ttBytes.length,
        tbvideoSavedBytes: zyBytes.length,
      };
    }

    // --- Prototype 6: Non-whitelisted long-tail domain zero-egress isolation ---
    {
      const blockedWeb = await webExtRpc({
        type: "WEB_EXT_ENQUEUE_MEDIA",
        payload: {
          kind: "direct_download",
          platform: "generic_hls",
          title: "Unwhitelisted Test",
          filename: "blocked.mp4",
          routes: [`https://${UNWHITELISTED_HOST}/stream/video.mp4`],
          mimeType: "video/mp4",
        },
      });
      assert.equal(blockedWeb?.ok, false, "Web bridge must reject unwhitelisted CDN");
      assert.equal(blockedWeb.code, "UNWHITELISTED_CDN");

      const blockedSp = await sidePanelRpc({
        type: "ENQUEUE_DOWNLOADS",
        items: [
          {
            title: "Unwhitelisted HLS",
            platform: "generic_hls",
            spec: {
              kind: "hls",
              apiOrigin: "https://snap.dokitool.com",
              routes: [`https://${UNWHITELISTED_HOST}/hls/master.m3u8`],
              filename: "blocked-hls.mp4",
              mimeType: "video/mp4",
            },
          },
        ],
      });
      assert.equal(blockedSp?.ok, true);
      const doneBlocked = await waitSidePanelTask(
        blockedSp.data.taskIds[0],
        "unwhitelisted HLS rejection",
      );
      assert.equal(doneBlocked.status, "failed");
      assert.equal(doneBlocked.lastErrorCode, "UNWHITELISTED_CDN");
      assert.equal(
        infra.state.proxyHits.get(UNWHITELISTED_HOST) || 0,
        0,
        "Zero CONNECT requests may be emitted toward unwhitelisted domains",
      );
      assert.equal(infra.state.unwhitelistedHttpRequests, 0);
      report.scenarios.unwhitelisted_zero_egress = {
        passed: true,
        webBridgeCode: blockedWeb.code,
        sidePanelErrorCode: doneBlocked.lastErrorCode,
        proxyHitsToUnwhitelisted: 0,
      };
    }

    await chromeMgr.killInstance(instA.record);

    // =========================================================================
    // INSTANCE B: Pure Web M1 (zero extension)
    // Covers:
    //   - Prototype 5 (M1): cors_blocked (Toutiao) mild guide without crash/navigation
    //   - Special Regression 1: Web SW upgrade deadlock recovery (< 3s activation + real download)
    // =========================================================================
    const dlDirB = path.join(resolvedRunDir, "downloads-web-m1");
    const instB = await chromeMgr.launch({
      profileDir: path.join(resolvedRunDir, "profile-web-m1"),
      downloadDir: dlDirB,
      extensionDirs: [],
    });

    const { targetId: m1TargetId } = await instB.browser.send("Target.createTarget", {
      url: "https://snap.dokitool.com/",
    });
    const m1Session = await instB.attach(m1TargetId);
    await until(
      () =>
        instB.evaluate(
          m1Session,
          "(() => { const input = document.querySelector('input[data-initial-url]'); const btn = document.querySelector('button.enterprise-btn'); return Boolean(input && btn && !btn.disabled); })()",
        ),
      "M1 SPA hydrated and ready",
    );

    // --- Prototype 5 (M1): CORS-blocked Toutiao gentle guidance without leaving page ---
    {
      await instB.evaluate(
        m1Session,
        `(() => {
          const input = document.querySelector('input[data-initial-url]');
          input.value = 'https://www.toutiao.com/video/7501991960077500979/';
          input.dispatchEvent(new Event('input', { bubbles: true }));
        })()`,
        true,
      );
      await delay(50);
      await instB.evaluate(
        m1Session,
        `document.querySelector('button.enterprise-btn').click()`,
        true,
      );
      await until(
        () =>
          instB.evaluate(
            m1Session,
            `document.body.innerText.includes('深海科考实录片段') && !!document.querySelector('button.rs-btn--primary')`,
          ),
        "M1 Toutiao parsed",
      );
      const hrefBefore = await instB.evaluate(m1Session, "location.href");
      // Click without transient user gesture -> must settle gently in manual state preserving page
      await instB.evaluate(
        m1Session,
        `document.querySelector('button.rs-btn--primary').click()`,
        false,
      );
      const m1State = await until(
        () =>
          instB.evaluate(
            m1Session,
            `(() => {
              const cards = [...document.querySelectorAll('[data-download-state]')].map(el => ({
                state: el.dataset.downloadState,
                text: el.innerText,
              }));
              return cards.length > 0 ? { href: location.href, cards } : null;
            })()`,
          ),
        "M1 Toutiao manual/guidance state",
        10_000,
      );
      assert.equal(m1State.href, hrefBefore, "M1 Toutiao must not navigate current tab away");
      assert.ok(
        m1State.cards.some((c) => ["manual", "handed-off"].includes(c.state)),
        `M1 Toutiao must settle in gentle manual/handed-off guidance, got: ${JSON.stringify(m1State.cards)}`,
      );
      report.scenarios.cors_blocked_m1_guide = {
        passed: true,
        cardStates: m1State.cards.map((c) => c.state),
      };
    }

    // --- Special Regression 1: Web SW upgrade deadlock self-heal (< 3s) ---
    {
      // Part 1: Attach an UNCONTROLLED `/downloads/bridge.html` iframe BEFORE registering
      // `/downloads/worker.js` (the exact Issue #48 [P0-1] orphan-bridge deadlock trigger
      // where `includeUncontrolled: true` used to wedge install in `waiting` forever).
      const tInstall = Date.now();
      const initialBuild = await instB.evaluate(
        m1Session,
        `(async () => {
          const orphanFrame = document.createElement('iframe');
          orphanFrame.id = 'e2e-orphan-bridge';
          orphanFrame.src = '/downloads/bridge.html';
          orphanFrame.hidden = true;
          await new Promise((resolve, reject) => {
            orphanFrame.onload = resolve;
            orphanFrame.onerror = reject;
            document.body.appendChild(orphanFrame);
          });
          const reg = await navigator.serviceWorker.register('/downloads/worker.js', { scope: '/downloads/', type: 'module', updateViaCache: 'none' });
          await new Promise((resolve, reject) => {
            const deadline = setTimeout(() => reject(new Error('Orphan bridge deadlocked initial SW install')), 2800);
            const w = reg.active || reg.installing || reg.waiting;
            if (!w) { clearTimeout(deadline); return reject(new Error('no worker')); }
            if (w.state === 'activated') { clearTimeout(deadline); return resolve(); }
            w.addEventListener('statechange', () => {
              if (w.state === 'activated') { clearTimeout(deadline); resolve(); }
            });
          });
          orphanFrame.remove();
          // Now attach a v1-controlled bridge iframe to test live upgrade protection + release wakeup
          const controlledFrame = document.createElement('iframe');
          controlledFrame.id = 'e2e-controlled-bridge';
          controlledFrame.src = '/downloads/bridge.html';
          controlledFrame.hidden = true;
          await new Promise((resolve, reject) => {
            controlledFrame.onload = resolve;
            controlledFrame.onerror = reject;
            document.body.appendChild(controlledFrame);
          });
          const reply = await new Promise((resolve, reject) => {
            const ch = new MessageChannel();
            ch.port1.onmessage = (e) => { ch.port1.close(); resolve(e.data); };
            reg.active.postMessage({ protocol: 1, action: 'ping' }, [ch.port2]);
            setTimeout(() => reject(new Error('v1 ping timeout')), 5000);
          });
          return reply.workerBuild;
        })()`,
      );
      const orphanInstallMs = Date.now() - tInstall;
      assert.ok(initialBuild, "v1 download SW must activate despite pre-existing orphan bridge iframe");
      assert.ok(
        orphanInstallMs < 3000,
        `Orphan-bridge SW activation took ${orphanInstallMs}ms (must be < 3000ms)`,
      );

      // Part 2: Publish upgraded v2 worker.js while v1 controls bridge.html -> v2 enters waiting;
      // releasing the lingering bridge + sending `skip-waiting` must activate v2 in < 3s.
      const upgradedBuild = `${initialBuild}-e2e-upgrade`;
      infra.state.workerVersionOverride = upgradedBuild;

      const recovery = await instB.evaluate(
        m1Session,
        `(async () => {
          const reg = await navigator.serviceWorker.getRegistration('/downloads/');
          await reg.update();
          const waitSettled = async () => {
            for (let i = 0; i < 40; i++) {
              if (reg.waiting) return 'waiting';
              if (reg.active && !reg.installing) {
                const ping = await new Promise((res) => {
                  const ch = new MessageChannel();
                  ch.port1.onmessage = (e) => { ch.port1.close(); res(e.data); };
                  reg.active.postMessage({ protocol: 1, action: 'ping' }, [ch.port2]);
                });
                if (ping.workerBuild === ${JSON.stringify(upgradedBuild)}) return 'already-active';
              }
              await new Promise(r => setTimeout(r, 50));
            }
            return 'timeout';
          };
          const stage = await waitSettled();
          // Release lingering controlled bridge iframe, then time skip-waiting self-heal activation (< 3s)
          const tHealStart = performance.now();
          document.getElementById('e2e-controlled-bridge')?.remove();
          await new Promise(r => setTimeout(r, 60));
          let nudged = false;
          if (stage === 'waiting' && reg.waiting) {
            nudged = true;
            reg.waiting.postMessage({ protocol: 1, action: 'skip-waiting' });
            await new Promise((resolve, reject) => {
              const deadline = setTimeout(() => reject(new Error('SW stuck in waiting after skip-waiting')), 2800);
              const check = () => {
                if (!reg.waiting && reg.active && reg.active.state === 'activated') {
                  clearTimeout(deadline);
                  resolve();
                } else {
                  setTimeout(check, 40);
                }
              };
              check();
            });
          }
          const recoveryMs = Math.round(performance.now() - tHealStart);
          const finalPing = await new Promise((resolve, reject) => {
            const ch = new MessageChannel();
            ch.port1.onmessage = (e) => { ch.port1.close(); resolve(e.data); };
            reg.active.postMessage({ protocol: 1, action: 'ping' }, [ch.port2]);
            setTimeout(() => reject(new Error('v2 ping timeout')), 3000);
          });
          // Verify real streaming download through upgraded worker saves valid file on disk
          const taskId = crypto.randomUUID();
          const token = crypto.randomUUID();
          const startReply = await new Promise((resolve, reject) => {
            const ch = new MessageChannel();
            ch.port1.onmessage = (e) => { ch.port1.close(); resolve(e.data); };
            reg.active.postMessage({
              protocol: 1,
              action: 'start',
              token,
              admission: true,
              request: {
                id: taskId,
                url: 'https://snap.dokitool.com/api/media/weibo?ticket=sw-upgrade-check',
                filename: 'sw_upgrade_healed.mp4',
              },
            }, [ch.port2]);
            setTimeout(() => reject(new Error('start timeout')), 3000);
          });
          const claimFrame = document.createElement('iframe');
          claimFrame.hidden = true;
          claimFrame.src = '/downloads/file/' + taskId + '/' + token;
          document.body.appendChild(claimFrame);
          return { stage, nudged, recoveryMs, waitingNull: !reg.waiting, finalBuild: finalPing.workerBuild, delivery: startReply?.snapshot?.delivery };
        })()`,
      );
      const recoveryMs = recovery.recoveryMs;
      assert.equal(recovery.waitingNull, true, "Upgraded SW must not remain stuck in waiting");
      assert.equal(recovery.finalBuild, upgradedBuild);
      assert.equal(recovery.delivery, "ready");
      assert.ok(
        recoveryMs < 3000,
        `SW upgrade recovery took ${recoveryMs}ms (must be < 3000ms)`,
      );

      const healedFile = await waitForFileOnDisk(
        path.join(dlDirB, "sw_upgrade_healed.mp4"),
        512,
      );
      assert.equal(sha256(healedFile), sha256(infra.fixtures.avcMp4));
      infra.state.workerVersionOverride = null;
      report.scenarios.sw_upgrade_deadlock = {
        passed: true,
        initialBuild,
        upgradedBuild,
        orphanInstallMs,
        stage: recovery.stage,
        nudged: recovery.nudged,
        recoveryMs,
        savedBytes: healedFile.length,
      };
    }

    await chromeMgr.killInstance(instB.record);

    // =========================================================================
    // INSTANCE C: Adversarial `onDeterminingFilename` Conflict Extension Regression
    // Loads DokiTool extension FIRST, then minimal third-party conflict extension SECOND
    // so Chromium's "later extension wins onDeterminingFilename" rule fires genuinely.
    // =========================================================================
    const conflictExtDir = await createConflictFixtureExtension(
      path.join(resolvedRunDir, "conflict-ext"),
    );
    const dlDirC = path.join(resolvedRunDir, "downloads-conflict");
    const instC = await chromeMgr.launch({
      profileDir: path.join(resolvedRunDir, "profile-conflict"),
      downloadDir: dlDirC,
      extensionDirs: [extDir, conflictExtDir],
    });

    // Wait for BOTH DokiTool extension and conflict-ext MV3 service workers to initialize
    // so conflict-ext's `onDeterminingFilename` listener is deterministically registered on slow CI runners.
    await until(
      async () => {
        const { targetInfos } = await instC.browser.send("Target.getTargets");
        const extWorkers = (targetInfos || []).filter(
          (t) =>
            t.type === "service_worker" &&
            typeof t.url === "string" &&
            t.url.startsWith("chrome-extension://"),
        );
        return extWorkers.length >= 2;
      },
      "both DokiTool and conflict-ext service workers ready",
      15_000,
    );

    const { targetId: conflictWebTarget } = await instC.browser.send(
      "Target.createTarget",
      { url: "https://snap.dokitool.com/" },
    );
    const conflictWebSession = await instC.attach(conflictWebTarget);
    await until(
      () => instC.evaluate(conflictWebSession, "document.readyState === 'complete'"),
      "conflict test web page loaded",
    );
    await until(
      () =>
        instC.evaluate(
          conflictWebSession,
          `new Promise((resolve) => {
            if (!window.chrome?.runtime?.sendMessage) return resolve(null);
            chrome.runtime.sendMessage(${JSON.stringify(DOKITOOL_EXTENSION_ID)}, { type: "WEB_EXT_PING" }, (resp) => {
              resolve(resp?.ok ? resp.data : null);
            });
          })`,
        ),
      "conflict test WEB_EXT_PING",
      15_000,
    );

    const conflictEnq = await instC.evaluate(
      conflictWebSession,
      `new Promise((resolve) => {
        chrome.runtime.sendMessage(${JSON.stringify(DOKITOOL_EXTENSION_ID)}, {
          type: "WEB_EXT_ENQUEUE_MEDIA",
          payload: {
            kind: "direct_download",
            platform: "toutiao",
            title: "原始中文标题防篡改测试",
            filename: "原始中文标题防篡改测试.mp4",
            routes: ["https://v26-default.toutiaovod.com/e2e/stream-no-ext"],
            mimeType: "video/mp4",
          },
        }, (resp) => resolve(resp));
      })`,
    );
    assert.equal(conflictEnq?.ok, true);
    const conflictTaskId = conflictEnq.data.taskId;

    // Wait for completion and verify BOTH Web bridge and SidePanel report `filenameWarning`
    const webConflictStatus = await until(
      () =>
        instC.evaluate(
          conflictWebSession,
          `new Promise((resolve) => {
            chrome.runtime.sendMessage(${JSON.stringify(DOKITOOL_EXTENSION_ID)}, {
              type: "WEB_EXT_GET_TASK_STATUS",
              taskId: ${JSON.stringify(conflictTaskId)},
            }, (resp) => {
              const st = resp?.ok ? resp.data : null;
              resolve(st && ["completed", "failed"].includes(st.phase) ? st : null);
            });
          })`,
        ),
      "conflict download terminal status",
      20_000,
    );
    assert.equal(webConflictStatus.phase, "completed");
    assert.ok(
      typeof webConflictStatus.filenameWarning === "string" &&
        webConflictStatus.filenameWarning.includes(EXPECTED_TAMPER_WARNING_FRAGMENT),
      `Expected Web bridge filenameWarning on UUID hijack, got: ${JSON.stringify(webConflictStatus)}`,
    );

    // Confirm real Chromium saved the hijacked UUID file on disk
    const hijackedBytes = await waitForFileOnDisk(
      path.join(dlDirC, "123e4567-e89b-12d3-a456-426614174000.mp4"),
      512,
    );
    assert.equal(sha256(hijackedBytes), sha256(infra.fixtures.avcMp4));

    // Also verify SidePanel GET_INITIAL_STATE surfaces the same warning
    const { targetId: conflictSpTarget } = await instC.browser.send(
      "Target.createTarget",
      { url: `chrome-extension://${DOKITOOL_EXTENSION_ID}/sidepanel.html` },
    );
    const conflictSpSession = await instC.attach(conflictSpTarget);
    await until(
      () =>
        instC.evaluate(
          conflictSpSession,
          "document.readyState === 'complete' && location.protocol === 'chrome-extension:' && Boolean(globalThis.chrome?.runtime?.sendMessage)",
        ),
      "conflict SidePanel loaded",
    );
    const spState = await instC.evaluate(
      conflictSpSession,
      `chrome.runtime.sendMessage({ type: "GET_INITIAL_STATE" })`,
    );
    const spConflictTask = spState?.data?.tasks?.find((t) => t.taskId === conflictTaskId);
    assert.ok(
      spConflictTask?.filenameWarning?.includes(EXPECTED_TAMPER_WARNING_FRAGMENT),
      `Expected SidePanel task filenameWarning, got: ${JSON.stringify(spConflictTask)}`,
    );
    report.scenarios.filename_conflict_audit = {
      passed: true,
      hijackedFilename: "123e4567-e89b-12d3-a456-426614174000.mp4",
      webBridgeWarningDetected: true,
      sidePanelWarningDetected: true,
    };

    await chromeMgr.killInstance(instC.record);
    report.passed = true;
  } finally {
    const residual = await chromeMgr.closeAll();
    report.residualChrome = residual;
    report.finishedAt = new Date().toISOString();
    await infra.close().catch(() => {});
    await fsp.writeFile(
      path.join(resolvedRunDir, "extension-e2e-results.json"),
      JSON.stringify(report, null, 2) + "\n",
      "utf8",
    );
  }

  assert.equal(
    report.residualChrome,
    0,
    `Expected RESIDUAL_CHROME=0, found ${report.residualChrome}`,
  );
  console.log(
    `L2 Real-Extension E2E PASSED (${Object.keys(report.scenarios).length} scenarios, ext=${report.extensionVersion}, RESIDUAL_CHROME=${report.residualChrome})`,
  );
  return report;
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const [runDir, distDir, extDir] = process.argv.slice(2);
  if (!runDir) {
    console.error(
      "Usage: node scripts/test-extension-e2e.mjs <run-dir> [dist-dir] [ext-dir]",
    );
    process.exit(1);
  }
  await runExtensionE2E({
    runDir,
    distDir: distDir || DEFAULT_DIST_DIR,
    extDir: extDir || DEFAULT_EXT_DIR,
  });
}
