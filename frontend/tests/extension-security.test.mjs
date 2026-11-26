import test, { before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build, stop } from "esbuild";
import JSZip from "jszip";
import {
  DOKITOOL_EXTENSION_ID,
  DOKITOOL_EXTENSION_MANIFEST_KEY,
  DEV_LOOPBACK_EXTERNALLY_CONNECTABLE_MATCHES,
  PROD_EXTERNALLY_CONNECTABLE_MATCHES,
  buildExtension,
  createDeterministicZipBuffer,
  deriveExtensionIdFromManifestKey,
  packageExtensionZip,
  verifyExtensionDist,
  verifyExtensionZip,
} from "../scripts/build-extension.mjs";

let hostWhitelist;
let dnrRules;
let urlMatcher;
let storage;
let protocol;
let backgroundMod;
let extensionBridge;
let extensionDownloadMod;
let youtubeExtensionBridgeMod;
let youtubeHelperSource = "";

async function bundleTsModule(relPath) {
  const absEntry = fileURLToPath(new URL(relPath, import.meta.url));
  const bundled = await build({
    entryPoints: [absEntry],
    bundle: true,
    write: false,
    platform: "node",
    format: "esm",
  });
  const code = bundled.outputFiles[0].text;
  return import(
    `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`
  );
}

before(async () => {
  globalThis.__DOKITOOL_EXT_TEST__ = true;
  let offscreenBundle;
  [
    hostWhitelist,
    dnrRules,
    urlMatcher,
    storage,
    protocol,
    backgroundMod,
    extensionBridge,
    offscreenBundle,
    youtubeHelperSource,
  ] = await Promise.all([
    bundleTsModule("../src/extension/hostWhitelist.ts"),
    bundleTsModule("../src/extension/dnrRules.ts"),
    bundleTsModule("../src/extension/urlMatcher.ts"),
    bundleTsModule("../src/extension/storage.ts"),
    bundleTsModule("../src/extension/protocol.ts"),
    bundleTsModule("../src/extension/background.ts"),
    bundleTsModule("../src/services/extensionBridge.ts"),
    (async () => {
      const bundled = await build({
        stdin: {
          contents: `
            export * as extensionDownloadMod from "./src/extension/extensionDownload.ts";
            export * as youtubeExtensionBridgeMod from "./src/extension/youtubeExtensionBridge.ts";
          `,
          resolveDir: fileURLToPath(new URL("..", import.meta.url)),
          loader: "ts",
        },
        bundle: true,
        write: false,
        platform: "node",
        format: "esm",
      });
      return import(
        `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`
      );
    })(),
    readFile(
      new URL("../src/utils/youtubeHelperCore.js", import.meta.url),
      "utf8",
    ),
  ]);
  extensionDownloadMod = offscreenBundle.extensionDownloadMod;
  youtubeExtensionBridgeMod = offscreenBundle.youtubeExtensionBridgeMod;
});

beforeEach(() => {
  storage.resetInMemoryExtensionStorage();
});

after(() => {
  stop();
});

test("hostWhitelist: zero wildcards, loopback isolated to optional_host_permissions unless devLoopback=true", () => {
  const forbidden = [
    "<all_urls>",
    "*://*/*",
    "http://*/*",
    "https://*/*",
  ];

  const prodManifest = hostWhitelist.buildManifestHostPermissions();
  const devManifest = hostWhitelist.buildManifestHostPermissions({
    devLoopback: true,
  });

  for (const list of [
    hostWhitelist.PRODUCTION_HOST_PERMISSIONS,
    hostWhitelist.LOOPBACK_HOST_PERMISSIONS,
    prodManifest.host_permissions,
    prodManifest.optional_host_permissions,
    devManifest.host_permissions,
    devManifest.optional_host_permissions,
  ]) {
    for (const wildcard of forbidden) {
      assert.equal(
        list.includes(wildcard),
        false,
        `must never include forbidden wildcard ${wildcard}`,
      );
    }
    for (const pattern of list) {
      assert.match(
        pattern,
        /^https?:\/\/(?:\*\.)?[a-z0-9.-]+\/\*$/,
        `invalid MV3 host permission pattern: ${pattern}`,
      );
    }
  }

  // Loopback excluded from default production host_permissions
  assert.equal(
    prodManifest.host_permissions.some(
      (p) => p.includes("127.0.0.1") || p.includes("localhost"),
    ),
    false,
  );
  assert.deepEqual(prodManifest.optional_host_permissions, [
    "http://127.0.0.1/*",
    "http://localhost/*",
  ]);

  // Loopback merged into host_permissions ONLY when devLoopback: true
  assert.ok(devManifest.host_permissions.includes("http://127.0.0.1/*"));
  assert.ok(devManifest.host_permissions.includes("http://localhost/*"));
  assert.deepEqual(devManifest.optional_host_permissions, []);
});

test("hostWhitelist: covers prod API, tbvideo.ixiaochuan.cn, and all 14 platform CDNs while rejecting unwhitelisted hosts", () => {
  const allowedUrls = [
    // Prod API & Weibo relay
    "https://snap.dokitool.com/api/media/weibo?ticket=abc.def",
    // YouTube
    "https://www.youtube.com/youtubei/v1/player",
    "https://youtube.com/oembed?format=json",
    "https://rr1---sn-a5mekn6s.googlevideo.com/videoplayback?expire=1",
    "https://i.ytimg.com/vi/I9JvDaciaFk/maxresdefault.jpg",
    "https://yt3.ggpht.com/ytc/avatar.jpg",
    "https://lh3.googleusercontent.com/cover.jpg",
    // Bilibili
    "https://upos-sz-mirrorcos.bilivideo.com/upgcxcode/a.mp4",
    "http://cn-http.bilivideo.com/upgcxcode/a.mp4",
    "https://cn-sh.bilivideo.cn/upgcxcode/a.mp4",
    "https://i0.hdslb.com/bfs/archive/cover.jpg",
    "http://i0.hdslb.com/bfs/archive/cover.jpg",
    "https://upos-hz-mirrorakam.akamaized.net/upgcxcode/a.mp4",
    // Douyin / Toutiao / Xigua / Pipixia
    "https://v26-cold.douyinvod.com/video.mp4",
    "http://v26-web.douyinvod.com/video.mp4",
    "https://sf3-cdn-tos.douyinstatic.com/obj/ies-music/audio.mp3",
    "https://v3-dy-o.zjcdn.com/video.mp4",
    "https://p3-pc-sign.douyinpic.com/image.jpeg",
    "https://p3-ppx-sign.byteimg.com/image.webp",
    "http://p3-ppx-sign.byteimg.com/image.webp",
    "https://v3-sign.toutiaovod.com/video.mp4",
    "https://p3-sign.toutiaoimg.com/cover.jpg",
    "https://v3-tt.ixigua.com/video.mp4",
    "https://p3.pstatp.com/large/cover.jpg",
    "https://v26-cdn-tos.ppxvod.com/video.mp4",
    "http://v26-cdn-tos.ppxvod.com/video.mp4",
    "https://h5.pipix.com/item/1",
    "https://aweme.snssdk.com/aweme/v1/play/?video_id=1",
    "https://api.amemv.com/aweme/v1/play/",
    "https://sf16-ies-music-va.ibytedtos.com/obj/a.mp3",
    "https://v3.bytedgame.com/a.mp4",
    "https://www.iesdouyin.com/aweme/v1/play/",
    "https://www.douyin.com/aweme/v1/play/?video_id=1",
    // Weibo
    "https://f.video.weibocdn.com/000abc.mp4?label=mp4_1080p",
    "http://f.video.weibocdn.com/000abc.mp4",
    "https://wx1.sinaimg.cn/large/cover.jpg",
    "http://wx2.sinaimg.cn/large/cover.jpg",
    // Xiaohongshu
    "https://sns-video-bd.xhscdn.com/stream/1.mp4",
    "http://sns-img-hw.xhscdn.com/note/1.jpg",
    "https://sns-web-i10.rednotecdn.com/note/1.webp",
    "https://ci.xiaohongshu.com/note/1.jpg",
    // Kuaishou
    "https://alimov2.a.kwimgs.com/upic/1.mp4",
    "http://txmov2.a.kwimgs.com/upic/1.mp4",
    "https://p2.a.yximgs.com/upic/1.jpg",
    "http://tx2.a.yximgs.com/upic/1.jpg",
    "https://v1.kwaicdn.com/upic/1.mp4",
    "https://www.kuaishou.com/cover.jpg",
    // Zuiyou / Pipigx / tbvideo
    "https://tbvideo.ixiaochuan.cn/zyvd/12/34/5678",
    "https://web-v01.izuiyou.com/zyvd/1.mp4",
    "http://web-f01.izuiyou.com/img/1.jpg",
    "https://cdn.xiaochuankeji.cn/img/1.jpg",
    "https://img.ixiaochuankeji.cn/img/1.jpg",
    "https://file.ippzone.com/img/frame/id/123",
    "https://h5.pipigx.com/cover.jpg",
    "http://video01.szsttkj.com/ppvd/1.mp4",
    "https://video03.szsttkj.com/ppvd/1.mp4",
    // X
    "https://video.twimg.com/ext_tw_video/1/pu/vid/avc1/1080x1920/a.mp4",
    "https://pbs.twimg.com/media/abc.jpg",
    // Instagram / Facebook
    "https://scontent.cdninstagram.com/v/t51.2885-15/a.jpg",
    "https://video-nrt6-1.xx.fbcdn.net/v/t42.1790-2/a.mp4",
    "http://video-nrt6-1.xx.fbcdn.net/v/t42.1790-2/a.mp4",
    "https://www.instagram.com/static/a.jpg",
    // Tumblr
    "https://va.media.tumblr.com/tumblr_xyz.mp4",
    "http://64.media.tumblr.com/xyz.jpg",
    "https://www.tumblr.com/xyz.jpg",
  ];

  for (const mediaUrl of allowedUrls) {
    const res = hostWhitelist.isWhitelistedMediaUrl(mediaUrl);
    assert.equal(
      res.allowed,
      true,
      `expected whitelisted media URL: ${mediaUrl} (reason: ${res.reason})`,
    );
  }

  const rejectedUrls = [
    "https://evil.example.com/video.mp4",
    "https://v26-cold.douyinvod.com.evil.test/video.mp4",
    "https://googlevideo.com.attacker.example/videoplayback",
    "http://rr1---sn-abc.googlevideo.com/videoplayback", // YouTube is HTTPS-only
    "http://127.0.0.1:18080/mock.mp4", // Loopback rejected unless authorized in extraAllowedOrigins
    "https://user:pass@f.video.weibocdn.com/a.mp4",
    "https://f.video.weibocdn.com:8443/a.mp4",
    "https://f.video.weibocdn.com/a.mp4#frag",
    "file:///etc/passwd",
  ];

  for (const badUrl of rejectedUrls) {
    const res = hostWhitelist.isWhitelistedMediaUrl(badUrl);
    assert.equal(res.allowed, false, `expected rejected URL: ${badUrl}`);
  }

  // Authorized loopback / custom HTTPS API origin passes when provided in extraAllowedOrigins
  assert.equal(
    hostWhitelist.isWhitelistedMediaUrl("http://127.0.0.1:18080/mock.mp4", [
      "http://127.0.0.1:18080",
    ]).allowed,
    true,
  );
  assert.equal(
    hostWhitelist.isWhitelistedMediaUrl(
      "https://api.my-dokitool.example/api/media/weibo?ticket=1",
      ["https://api.my-dokitool.example"],
    ).allowed,
    true,
  );
});

test("hostWhitelist: validateApiBaseUrl enforces HTTPS public domains or HTTP loopback only", () => {
  const prod = hostWhitelist.validateApiBaseUrl("https://snap.dokitool.com/");
  assert.deepEqual(prod, {
    ok: true,
    origin: "https://snap.dokitool.com",
    isLoopback: false,
  });

  const customHttps = hostWhitelist.validateApiBaseUrl(
    "https://api.dokitool-mirror.com:8443/",
  );
  assert.deepEqual(customHttps, {
    ok: true,
    origin: "https://api.dokitool-mirror.com:8443",
    isLoopback: false,
  });

  const lo1 = hostWhitelist.validateApiBaseUrl("http://127.0.0.1:18080/");
  assert.deepEqual(lo1, {
    ok: true,
    origin: "http://127.0.0.1:18080",
    isLoopback: true,
  });

  const lo2 = hostWhitelist.validateApiBaseUrl("http://localhost:8787");
  assert.deepEqual(lo2, {
    ok: true,
    origin: "http://localhost:8787",
    isLoopback: true,
  });

  const invalidBaseUrls = [
    "",
    "   ",
    "http://evil.com",
    "http://snap.dokitool.com",
    "http://192.168.1.1",
    "http://192.168.1.1:8080",
    "https://192.168.1.1",
    "https://10.0.0.1",
    "https://172.16.0.1",
    "https://127.0.0.1:8443",
    "https://localhost:8443",
    "http://[::1]:8080",
    "https://[::1]:8443",
    "https://intranet.local",
    "https://singlelabel",
    "https://user:pass@snap.dokitool.com",
    "https://snap.dokitool.com/api/parse",
    "https://snap.dokitool.com?foo=bar",
    "https://snap.dokitool.com#hash",
    "chrome-extension://abcdefghijklmnopabcdefghijklmnop",
  ];

  for (const raw of invalidBaseUrls) {
    const check = hostWhitelist.validateApiBaseUrl(raw);
    assert.equal(check.ok, false, `expected invalid apiBaseUrl: ${raw}`);
    assert.ok(check.error, `expected error message for: ${raw}`);
  }
});

test("dnrRules: pins initiatorDomains=[extensionId] on every rule, configures Rules 1001-1008, and narrows Bilibili Akamai Referer (G1)", () => {
  for (const badId of ["", "UPPERCASE", "ext/id", "ext id", "../bad"]) {
    assert.throws(() => dnrRules.buildExtensionDnrRules(badId));
  }

  // Verify Tizen UA matches youtubeHelperCore.js character-for-character
  assert.ok(
    youtubeHelperSource.includes(dnrRules.YOUTUBE_TVHTML5_USER_AGENT),
    "YOUTUBE_TVHTML5_USER_AGENT must match youtubeHelperCore.js exactly",
  );

  const extId = "abcdefghijklmnopabcdefghijklmnop";
  const rules = dnrRules.buildExtensionDnrRules(extId, {
    extraApiOrigins: ["https://custom-gateway.example.com:8443/"],
  });

  assert.deepEqual(
    rules.map((r) => r.id),
    [1001, 1002, 1003, 1004, 1005, 1006, 1007, 1008],
  );
  assert.deepEqual(
    Array.from(dnrRules.EXTENSION_DNR_RULE_IDS),
    [1001, 1002, 1003, 1004, 1005, 1006, 1007, 1008],
  );

  for (const rule of rules) {
    assert.deepEqual(
      rule.condition.initiatorDomains,
      [extId],
      `rule ${rule.id} must scope initiatorDomains strictly to [extensionId]`,
    );
    assert.equal(rule.action.type, "modifyHeaders");
  }

  const [r1001, r1002, r1003, r1004, r1005, r1006, r1007, r1008] = rules;

  // Rule 1001: YouTube TVHTML5 player endpoint
  assert.equal(r1001.priority, 3);
  assert.equal(
    r1001.condition.urlFilter,
    "||www.youtube.com/youtubei/v1/player",
  );
  assert.deepEqual(r1001.condition.resourceTypes, ["xmlhttprequest"]);
  assert.deepEqual(r1001.action.requestHeaders, [
    {
      header: "User-Agent",
      operation: "set",
      value:
        "Mozilla/5.0 (SMART-TV; Linux; Tizen 2.4.0) AppleWebKit/538.1 (KHTML, like Gecko) Version/2.4.0 TV Safari/538.1",
    },
    { header: "Origin", operation: "set", value: "https://www.youtube.com" },
    {
      header: "Referer",
      operation: "set",
      value: "https://www.youtube.com/tv",
    },
    { header: "Cookie", operation: "remove" },
  ]);

  // Rule 1002: YouTube & googlevideo streams/thumbnails
  assert.equal(r1002.priority, 2);
  assert.deepEqual(r1002.condition.requestDomains, [
    "googlevideo.com",
    "youtube.com",
    "ytimg.com",
    "ggpht.com",
    "googleusercontent.com",
  ]);
  assert.deepEqual(r1002.condition.resourceTypes, [
    "xmlhttprequest",
    "media",
    "image",
  ]);
  assert.deepEqual(r1002.action.requestHeaders, [
    { header: "Origin", operation: "remove" },
    { header: "Cookie", operation: "remove" },
  ]);

  // Rule 1003: Weibo Referer + remove Origin/Cookie
  assert.equal(r1003.priority, 2);
  assert.deepEqual(r1003.condition.requestDomains, [
    "weibocdn.com",
    "sinaimg.cn",
  ]);
  assert.deepEqual(r1003.action.requestHeaders, [
    { header: "Referer", operation: "set", value: "https://weibo.com/" },
    { header: "Origin", operation: "remove" },
    { header: "Cookie", operation: "remove" },
  ]);

  // Rule 1004: Bilibili domestic CDNs ONLY (G1 removes global akamaized.net)
  assert.equal(r1004.priority, 2);
  assert.deepEqual(r1004.condition.requestDomains, [
    "bilivideo.com",
    "bilivideo.cn",
    "hdslb.com",
  ]);
  assert.equal(
    r1004.condition.requestDomains.includes("akamaized.net"),
    false,
    "G1: global akamaized.net must NOT remain in Rule 1004",
  );
  assert.deepEqual(r1004.action.requestHeaders, [
    { header: "Referer", operation: "set", value: "https://www.bilibili.com/" },
    { header: "Origin", operation: "remove" },
    { header: "Cookie", operation: "remove" },
  ]);

  // Rule 1005: Remaining CDNs (including non-Bilibili akamaized.net) + prod/loopback/custom API origins
  assert.equal(r1005.priority, 1);
  assert.deepEqual(r1005.action.requestHeaders, [
    { header: "Origin", operation: "remove" },
    { header: "Cookie", operation: "remove" },
  ]);
  for (const expectedDomain of [
    "snap.dokitool.com",
    "127.0.0.1",
    "localhost",
    "custom-gateway.example.com",
    "akamaized.net",
    "douyinvod.com",
    "xhscdn.com",
    "rednotecdn.com",
    "ixiaochuan.cn",
    "szsttkj.com",
    "twimg.com",
    "cdninstagram.com",
    "fbcdn.net",
    "tumblr.com",
  ]) {
    assert.ok(
      r1005.condition.requestDomains.includes(expectedDomain),
      `Rule 1005 missing expected domain ${expectedDomain}`,
    );
  }
  for (const specialized of [
    "googlevideo.com",
    "weibocdn.com",
    "bilivideo.com",
  ]) {
    assert.equal(
      r1005.condition.requestDomains.includes(specialized),
      false,
      `Rule 1005 should not duplicate specialized domain ${specialized}`,
    );
  }

  // Rules 1006-1008 (G1): Narrow priority-3 Bilibili overseas Akamai UPOS matchers
  for (const [rule, expectedFilter] of [
    [r1006, "||upos-*.akamaized.net/"],
    [r1007, "://*bili*.akamaized.net/"],
    [r1008, "/upgcxcode/"],
  ]) {
    assert.equal(rule.priority, 3);
    assert.deepEqual(rule.condition.initiatorDomains, [extId]);
    assert.deepEqual(rule.condition.requestDomains, ["akamaized.net"]);
    assert.equal(rule.condition.urlFilter, expectedFilter);
    assert.deepEqual(rule.condition.resourceTypes, [
      "xmlhttprequest",
      "media",
      "image",
    ]);
    assert.deepEqual(rule.action.requestHeaders, [
      { header: "Referer", operation: "set", value: "https://www.bilibili.com/" },
      { header: "Origin", operation: "remove" },
      { header: "Cookie", operation: "remove" },
    ]);
  }

  // Bidirectional Chrome MV3 DNR matching simulation (G1)
  const matchesDnrUrlFilter = (urlStr, filter) => {
    if (!filter) return true;
    const escapeRegex = (s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
    if (filter.startsWith("||")) {
      const body = filter.slice(2).split("*").map(escapeRegex).join(".*");
      return new RegExp(`^[a-z][a-z0-9+.-]*://(?:[^/]+\\.)?${body}`, "i").test(
        urlStr,
      );
    }
    const body = filter.split("*").map(escapeRegex).join(".*");
    return new RegExp(body, "i").test(urlStr);
  };
  const simulateDnrRequest = (urlStr, initiatorDomain, resourceType = "xmlhttprequest") => {
    const parsed = new URL(urlStr);
    const host = parsed.hostname.toLowerCase();
    const matched = rules
      .filter((rule) => {
        if (!rule.condition.initiatorDomains.includes(initiatorDomain)) return false;
        if (!rule.condition.resourceTypes.includes(resourceType)) return false;
        if (rule.condition.requestDomains) {
          const domainOk = rule.condition.requestDomains.some(
            (d) => host === d || host.endsWith(`.${d}`),
          );
          if (!domainOk) return false;
        }
        return matchesDnrUrlFilter(urlStr, rule.condition.urlFilter);
      })
      .sort((a, b) => b.priority - a.priority || a.id - b.id);
    const headers = new Map([
      ["Origin", `chrome-extension://${initiatorDomain}`],
      ["Cookie", "sid=secret"],
    ]);
    const decided = new Set();
    for (const rule of matched) {
      for (const op of rule.action.requestHeaders) {
        const key = op.header.toLowerCase();
        if (decided.has(key)) continue;
        decided.add(key);
        if (op.operation === "set") headers.set(op.header, op.value);
        else if (op.operation === "remove") headers.delete(op.header);
      }
    }
    return { matchedIds: matched.map((r) => r.id), headers };
  };

  // Positive: Bilibili overseas Akamai UPOS / *bili* / /upgcxcode/ MUST get Bilibili Referer + stripped Origin/Cookie
  for (const biliAkamaiUrl of [
    "https://upos-hz-mirrorakam.akamaized.net/upgcxcode/720p.mp4",
    "https://upos-sz-mirrorakam.akamaized.net/dash/1080p.m4s",
    "https://bili-edge.akamaized.net/media/720p.mp4",
    "https://cn-bili-cdn.akamaized.net/chunk.m4s",
    "https://edge-mirror.akamaized.net/upgcxcode/12/34/56.m4s",
  ]) {
    const sim = simulateDnrRequest(biliAkamaiUrl, extId);
    assert.ok(
      sim.matchedIds.some((id) => id >= 1006 && id <= 1008),
      `expected narrow Bilibili Akamai rule (1006-1008) for ${biliAkamaiUrl}, got ${JSON.stringify(sim.matchedIds)}`,
    );
    assert.equal(sim.headers.get("Referer"), "https://www.bilibili.com/");
    assert.equal(sim.headers.has("Origin"), false);
    assert.equal(sim.headers.has("Cookie"), false);
  }

  // Negative: Vimeo / Facebook / Tumblr / generic Akamai URLs MUST match Rule 1005 ONLY with ZERO Referer
  for (const nonBiliAkamaiUrl of [
    "https://vod-progressive.akamaized.net/exp=1700/vimeo-1080p.mp4",
    "https://fbcdn-video-a.akamaized.net/hvideo-ak-prn/clip.mp4",
    "https://tumblr-media.akamaized.net/video/post123.mp4",
    "https://vod-progressive.akamaized.net/media/ability/video.mp4",
  ]) {
    const sim = simulateDnrRequest(nonBiliAkamaiUrl, extId);
    assert.deepEqual(
      sim.matchedIds,
      [1005],
      `non-Bilibili Akamai URL ${nonBiliAkamaiUrl} must fall strictly into Rule 1005, got ${JSON.stringify(sim.matchedIds)}`,
    );
    assert.equal(sim.headers.has("Referer"), false, `must inject zero Referer for ${nonBiliAkamaiUrl}`);
    assert.equal(sim.headers.has("Origin"), false);
    assert.equal(sim.headers.has("Cookie"), false);
  }

  // Normal browser tabs (non-extension initiator) match ZERO rules
  const tabSim = simulateDnrRequest(
    "https://upos-hz-mirrorakam.akamaized.net/upgcxcode/720p.mp4",
    "www.bilibili.com",
  );
  assert.deepEqual(tabSim.matchedIds, []);
});

test("urlMatcher: matches all 14 platforms & shortlinks and strictly blocks non-supported/private URLs", () => {
  const validSamples = [
    ["douyin", "https://www.douyin.com/jingxuan?modal_id=7704056737233449610"],
    ["douyin", "https://v.douyin.com/iYabcd/"],
    ["douyin", "https://www.iesdouyin.com/share/video/7704056737233449610/"],
    ["kuaishou", "https://www.kuaishou.com/short-video/3xngkmw8vacriqu"],
    ["kuaishou", "https://v.kuaishou.com/f/X-123abc"],
    ["kuaishou", "https://v.kuaishou.com/abcXYZ"],
    ["bilibili", "https://www.bilibili.com/video/BV1uv411q7Mv?p=2&spm_id_from=333"],
    ["bilibili", "https://b23.tv/abcDEF1"],
    [
      "xiaohongshu",
      "https://www.xiaohongshu.com/explore/66a1b2c3d4e5f6a7b8c9d0e1?xsec_token=SEC_TOKEN_1&xsec_source=pc_feed",
    ],
    ["xiaohongshu", "http://xhslink.com/o/ATlAvhS71F8"],
    ["xiaohongshu", "https://www.rednote.com/explore/66a1b2c3d4e5f6a7b8c9d0e1"],
    ["toutiao", "https://www.toutiao.com/video/7501991960077500979/"],
    ["toutiao", "https://m.toutiaoimg.com/group/7501991960077500979/"],
    ["weibo", "https://weibo.com/tv/show/1034:5339966948180025?from=old_pc_videoshow"],
    ["weibo", "https://m.weibo.cn/detail/5012345678901234"],
    ["pipixia", "https://h5.pipix.com/item/7385813877985909043"],
    ["pipigx", "https://h5.pipigx.com/pp/post/860538173891?pid=860538173891&mid=165822485"],
    ["pipigx", "https://h5.ippzone.com/pp/post/860538173891"],
    ["zuiyou", "https://share.xiaochuankeji.cn/hybrid/share/post?pid=163566379"],
    ["zuiyou", "https://h5.izuiyou.com/hybrid/share/post?pid=163566379"],
    ["x", "https://x.com/i/status/1575560063510810624"],
    ["x", "https://twitter.com/jack/status/20"],
    ["x", "https://t.co/AbCdEf123"],
    ["youtube", "https://www.youtube.com/watch?v=I9JvDaciaFk"],
    ["youtube", "https://www.youtube.com/shorts/I9JvDaciaFk?feature=share"],
    ["youtube", "https://youtu.be/I9JvDaciaFk?si=xyz"],
    ["instagram", "https://www.instagram.com/p/CTApqC8BGWd/"],
    ["instagram", "https://instagr.am/p/CTApqC8BGWd/"],
    ["facebook", "https://www.facebook.com/watch/?v=401590806345712"],
    ["facebook", "https://m.facebook.com/reel/1234567890/"],
    ["facebook", "https://fb.watch/abc123XYZ/"],
    [
      "tumblr",
      "https://maskofthedragon.tumblr.com/post/626907179849564160/mona-talking-in-english",
    ],
  ];

  const matchedPlatforms = new Set();
  for (const [expectedPlatform, sampleUrl] of validSamples) {
    const matched = urlMatcher.matchSupportedPlatformUrl(sampleUrl);
    assert.ok(matched, `expected match for ${sampleUrl}`);
    assert.equal(matched.platform, expectedPlatform);
    assert.equal(
      matched.isLikelyFeedOrHome,
      false,
      `expected work URL (not feed/home) for ${sampleUrl}`,
    );
    matchedPlatforms.add(matched.platform);
  }
  assert.equal(matchedPlatforms.size, 14, "all 14 platforms must be covered");

  // Preserve xsec_token in matched.url while normalizing dedupeKey
  const xhs1 = urlMatcher.matchSupportedPlatformUrl(
    "https://www.xiaohongshu.com/explore/66a1b2c3d4e5f6a7b8c9d0e1?xsec_token=TOK_A&utm_source=copy",
  );
  const xhs2 = urlMatcher.matchSupportedPlatformUrl(
    "https://www.xiaohongshu.com/explore/66a1b2c3d4e5f6a7b8c9d0e1?xsec_token=TOK_B",
  );
  assert.ok(xhs1.url.includes("xsec_token=TOK_A"));
  assert.equal(xhs1.dedupeKey, xhs2.dedupeKey);

  // YouTube videoId extraction & cross-format dedupe
  const ytWatch = urlMatcher.matchSupportedPlatformUrl(
    "https://www.youtube.com/watch?v=I9JvDaciaFk&pp=ygU",
  );
  const ytShort = urlMatcher.matchSupportedPlatformUrl(
    "https://youtu.be/I9JvDaciaFk?si=123",
  );
  assert.equal(ytWatch.youtubeVideoId, "I9JvDaciaFk");
  assert.equal(ytShort.youtubeVideoId, "I9JvDaciaFk");
  assert.equal(ytWatch.dedupeKey, ytShort.dedupeKey);

  // Feed / home root detection for auto-follow noise suppression
  for (const feedUrl of [
    "https://www.youtube.com/",
    "https://x.com/home",
    "https://www.bilibili.com/",
    "https://www.xiaohongshu.com/explore",
    "https://www.douyin.com/",
    "https://www.douyin.com/jingxuan",
  ]) {
    const m = urlMatcher.matchSupportedPlatformUrl(feedUrl);
    assert.ok(m, `feed URL ${feedUrl} should still match platform for manual use`);
    assert.equal(
      m.isLikelyFeedOrHome,
      true,
      `expected isLikelyFeedOrHome=true for ${feedUrl}`,
    );
  }

  // Privacy firewall: strictly return null on non-supported, internal, IP, port, userinfo, and exact-domain violations
  for (const blockedUrl of [
    "https://bank.example.test/account",
    "chrome://extensions",
    "chrome-extension://abcdefghijklmnopabcdefghijklmnop/sidepanel.html",
    "file:///etc/passwd",
    "about:blank",
    "javascript:alert(1)",
    "https://snap.dokitool.com/",
    "https://snap.dokitool.com/api/parse",
    "http://127.0.0.1:8080/watch?v=I9JvDaciaFk",
    "https://192.168.1.1/video/1",
    "https://user:pass@www.youtube.com/watch?v=I9JvDaciaFk",
    "https://www.youtube.com:8443/watch?v=I9JvDaciaFk",
    "http://www.youtube.com:443/watch?v=I9JvDaciaFk",
    "https://www.share.xiaochuankeji.cn/hybrid/share/post?pid=1", // exact-only domain
    "https://evil.xiaochuankeji.cn/hybrid/share/post?pid=1",
    "https://web.facebook.com/watch/?v=401590806345712", // exact-only domain
    "https://www.fb.watch/abc/",
    "https://youtube.com.evil.test/watch?v=I9JvDaciaFk",
    "https://dailymotion.com/video/x8abcde", // retired site
  ]) {
    assert.equal(
      urlMatcher.matchSupportedPlatformUrl(blockedUrl),
      null,
      `privacy firewall must return null for ${blockedUrl}`,
    );
  }
});

test("urlMatcher: extractSupportedUrlsFromText extracts, filters, and deduplicates batch links", () => {
  const batchInput = [
    "",
    "7.43 复制打开抖音，看看【精彩视频】 https://www.douyin.com/jingxuan?modal_id=7704056737233449610&ug_source=copy 03/12",
    "https://www.douyin.com/video/7704056737233449610",
    "https://bank.example.test/secret-statement",
    "这是一行无关备注文字",
    "【小红书】分享笔记 http://xhslink.com/o/ATlAvhS71F8，快来看！",
    "https://www.bilibili.com/video/BV1uv411q7Mv?p=1",
    "https://www.bilibili.com/video/BV1uv411q7Mv?spm_id_from=333.999",
    "   ",
  ].join("\n");

  const extracted = urlMatcher.extractSupportedUrlsFromText(batchInput);
  assert.equal(extracted.items.length, 3);
  assert.deepEqual(
    extracted.items.map((item) => item.platform),
    ["douyin", "xiaohongshu", "bilibili"],
  );
  assert.equal(extracted.items[1].url, "http://xhslink.com/o/ATlAvhS71F8");
  assert.equal(extracted.duplicateCount, 2);
  assert.equal(extracted.ignoredLineCount, 2);
});

test("urlMatcher P2-1: Kuaishou shortlink v.kuaishou.com/<code> & strictly lowercase TRACKING_QUERY_PARAMS (?share_Copy_Link=1 stripping)", () => {
  assert.ok(urlMatcher.TRACKING_QUERY_PARAMS instanceof Set);
  assert.ok(urlMatcher.TRACKING_QUERY_PARAMS.size > 0);
  for (const param of urlMatcher.TRACKING_QUERY_PARAMS) {
    assert.equal(
      param,
      param.toLowerCase(),
      `TRACKING_QUERY_PARAMS entry must be strictly lowercase: ${param}`,
    );
  }
  assert.equal(urlMatcher.TRACKING_QUERY_PARAMS.has("share_copy_link"), true);
  assert.equal(urlMatcher.TRACKING_QUERY_PARAMS.has("share_Copy_Link"), false);

  // v.kuaishou.com/<code> resolves to work shortlink (isLikelyFeedOrHome: false)
  const ksShort = urlMatcher.matchSupportedPlatformUrl(
    "https://v.kuaishou.com/abcXYZ?share_Copy_Link=1",
  );
  assert.ok(ksShort);
  assert.equal(ksShort.platform, "kuaishou");
  assert.equal(ksShort.dedupeKey, "kuaishou:short:abcXYZ");
  assert.equal(ksShort.isLikelyFeedOrHome, false);

  // Root v.kuaishou.com/ with empty path remains feed/home
  const ksRoot = urlMatcher.matchSupportedPlatformUrl("https://v.kuaishou.com/");
  assert.ok(ksRoot);
  assert.equal(ksRoot.isLikelyFeedOrHome, true);

  // Mixed-case ?share_Copy_Link=1 stripped in fallbackDedupeKey & batch deduplication
  const withShareCopy = urlMatcher.matchSupportedPlatformUrl(
    "https://www.toutiao.com/custom/page?id=99&share_Copy_Link=1",
  );
  const cleanUrl = urlMatcher.matchSupportedPlatformUrl(
    "https://www.toutiao.com/custom/page?id=99",
  );
  assert.ok(withShareCopy && cleanUrl);
  assert.equal(withShareCopy.dedupeKey, cleanUrl.dedupeKey);
  assert.equal(withShareCopy.dedupeKey.includes("share_Copy_Link"), false);

  const batchDeduped = urlMatcher.extractSupportedUrlsFromText(
    [
      "https://www.toutiao.com/custom/page?id=99&share_Copy_Link=1",
      "https://www.toutiao.com/custom/page?id=99",
      "https://v.kuaishou.com/abcXYZ",
      "https://v.kuaishou.com/abcXYZ?share_Copy_Link=1",
    ].join("\n"),
  );
  assert.equal(batchDeduped.items.length, 2);
  assert.equal(batchDeduped.duplicateCount, 2);
});

test("storage & protocol: token isolation, autoFollowTab transition, LRU 200 cap, and atomic intent consume", async () => {
  const localArea = storage.createMemoryStorageArea();
  const sessionArea = storage.createMemoryStorageArea();
  let fakeNow = 1_700_000_000_000;
  const store = storage.createExtensionStorage({
    local: localArea,
    session: sessionArea,
    now: () => ++fakeNow,
  });

  // 1. Anonymous defaults & header omission
  const initial = await store.getSettings();
  assert.deepEqual(initial, {
    apiBaseUrl: "https://snap.dokitool.com",
    bearerToken: "",
    subfolderPrefix: "",
    batchSaveMode: "subfolder",
    qualityPreference: "best",
    autoFollowTab: false,
    useSaveFilePicker: false,
    theme: "system",
  });
  const anonHeaders = storage.buildApiAuthHeaders(initial, {
    Accept: "application/json",
    Authorization: "should-be-stripped",
  });
  assert.equal("Authorization" in anonHeaders, false);
  assert.equal(anonHeaders.Accept, "application/json");

  // 2. Saving non-empty token enables autoFollowTab automatically & keeps token out of session storage
  const withToken = await store.updateSettings({
    bearerToken: "  doki_secret_token_123  ",
    subfolderPrefix: "../../DokiTool/Clips.. ",
  });
  assert.equal(withToken.bearerToken, "doki_secret_token_123");
  assert.equal(withToken.autoFollowTab, true);
  assert.equal(withToken.subfolderPrefix, "DokiTool/Clips");
  assert.deepEqual(storage.buildApiAuthHeaders(withToken), {
    Authorization: "Bearer doki_secret_token_123",
  });
  assert.equal(
    JSON.stringify(sessionArea.dump()).includes("doki_secret_token_123"),
    false,
    "bearerToken must never be written to session storage",
  );

  // User explicitly disables autoFollowTab -> survives subsequent token/preference edits
  const toggledOff = await store.updateSettings({ autoFollowTab: false });
  assert.equal(toggledOff.autoFollowTab, false);
  const rotatedToken = await store.updateSettings({
    bearerToken: "doki_secret_token_456",
  });
  assert.equal(rotatedToken.autoFollowTab, false);

  // Clearing token returns to anonymous mode (autoFollowTab = false)
  const clearedToken = await store.updateSettings({ bearerToken: "   " });
  assert.equal(clearedToken.bearerToken, "");
  assert.equal(clearedToken.autoFollowTab, false);

  // Invalid apiBaseUrl rejected
  await assert.rejects(() =>
    store.updateSettings({ apiBaseUrl: "http://evil.com" }),
  );

  // 3. SavedWorkRecord LRU 200 cap & promotion
  assert.equal(
    storage.buildWorkFingerprint({
      platform: "Bilibili",
      content_id: "BV1uv411q7Mv",
      source_url: "https://www.bilibili.com/video/BV1uv411q7Mv",
    }),
    "bilibili:BV1uv411q7Mv",
  );
  assert.equal(
    storage.buildWorkFingerprint({
      platform: "tumblr",
      source_url: "https://blog.tumblr.com/post/123",
    }),
    "tumblr:https://blog.tumblr.com/post/123",
  );

  for (let i = 1; i <= 205; i++) {
    await store.recordSavedWork({
      fingerprint: `douyin:item-${i}`,
      platform: "douyin",
      title: `Work ${i}`,
    });
  }
  let savedList = await store.getSavedWorks();
  assert.equal(savedList.length, 200);
  assert.equal(savedList[0].fingerprint, "douyin:item-205");
  assert.equal(savedList.at(-1).fingerprint, "douyin:item-6");
  assert.equal(await store.isWorkSaved("douyin:item-1"), false);
  assert.equal(await store.isWorkSaved("douyin:item-6"), true);

  // Re-saving item-6 promotes it to MRU index 0 without growing past 200
  await store.recordSavedWork({
    fingerprint: "douyin:item-6",
    platform: "douyin",
    title: "Work 6 Updated",
  });
  savedList = await store.getSavedWorks();
  assert.equal(savedList.length, 200);
  assert.equal(savedList[0].fingerprint, "douyin:item-6");
  assert.equal(savedList[0].title, "Work 6 Updated");

  // 4. Atomic pending intent consume in session storage
  await store.setPendingIntent({
    intentId: "intent-alpha",
    url: "https://www.youtube.com/watch?v=I9JvDaciaFk",
    mode: "inspect",
    createdAt: 1000,
  });
  assert.equal(
    JSON.stringify(localArea.dump()).includes("intent-alpha"),
    false,
    "pending intent must live in session storage, not local storage",
  );

  // Mismatched intentId does not consume current intent
  assert.equal(await store.consumePendingIntent("intent-wrong"), null);
  assert.equal((await store.getPendingIntent())?.intentId, "intent-alpha");

  // Concurrent consume calls: exactly one caller wins
  const [c1, c2] = await Promise.all([
    store.consumePendingIntent("intent-alpha"),
    store.consumePendingIntent("intent-alpha"),
  ]);
  const winners = [c1, c2].filter(Boolean);
  assert.equal(winners.length, 1);
  assert.equal(winners[0].intentId, "intent-alpha");
  assert.equal(await store.getPendingIntent(), null);

  // 5. Protocol runtime message guards
  assert.equal(protocol.isSidePanelRequest({ type: "GET_INITIAL_STATE" }), true);
  assert.equal(
    protocol.isBackgroundBroadcast({ type: "TASKS_UPDATED", tasks: [] }),
    true,
  );
  assert.equal(
    protocol.isBackgroundToOffscreenRequest({ type: "OFFSCREEN_PING" }),
    true,
  );
  assert.equal(
    protocol.isOffscreenToBackgroundMessage({
      type: "HANDOFF_BLOB_DOWNLOAD",
      taskId: "t1",
      blobUrl: "blob:chrome-extension://id/1",
      filename: "video.mp4",
    }),
    true,
  );
});

test("build-extension.mjs: builds valid MV3 dist, isolates loopback to optional_host_permissions by default, and enforces static security gates", async () => {
  const prodOut = await mkdtemp(join(tmpdir(), "dokitool-ext-prod-build-"));
  const devOut = await mkdtemp(join(tmpdir(), "dokitool-ext-dev-build-"));
  try {
    const prodBuilt = await buildExtension({
      devLoopback: false,
      outDir: prodOut,
      quiet: true,
    });
    const prodManifest = prodBuilt.manifest;

    assert.equal(prodManifest.manifest_version, 3);
    assert.equal(prodManifest.key, DOKITOOL_EXTENSION_MANIFEST_KEY);
    assert.equal(
      deriveExtensionIdFromManifestKey(prodManifest.key),
      DOKITOOL_EXTENSION_ID,
    );
    assert.deepEqual(prodManifest.externally_connectable, {
      matches: PROD_EXTERNALLY_CONNECTABLE_MATCHES,
    });
    assert.deepEqual(prodManifest.permissions, [
      "sidePanel",
      "offscreen",
      "downloads",
      "storage",
      "contextMenus",
      "tabs",
      "declarativeNetRequestWithHostAccess",
    ]);
    assert.equal(prodManifest.content_scripts, undefined);
    assert.equal(prodManifest.side_panel?.default_path, "sidepanel.html");
    assert.deepEqual(prodManifest.background, {
      service_worker: "background.js",
      type: "module",
    });
    assert.equal(
      prodManifest.commands?.["open-dokitool-sidepanel"]?.suggested_key?.default,
      "Alt+Shift+D",
    );
    assert.equal(
      prodManifest.content_security_policy?.extension_pages,
      "script-src 'self'; object-src 'self';",
    );
    assert.equal(
      prodManifest.host_permissions.some(
        (p) => p.includes("127.0.0.1") || p.includes("localhost"),
      ),
      false,
    );
    assert.deepEqual(prodManifest.optional_host_permissions, [
      "http://127.0.0.1/*",
      "http://localhost/*",
    ]);

    for (const rel of [
      "manifest.json",
      "background.js",
      "sidepanel.html",
      "offscreen.html",
      "icons/icon-16.png",
      "icons/icon-32.png",
      "icons/icon-48.png",
      "icons/icon-128.png",
    ]) {
      assert.equal(
        existsSync(join(prodOut, rel)),
        true,
        `expected artifact ${rel}`,
      );
    }

    assert.equal(
      existsSync(join(prodOut, "monitor.html")),
      false,
      "duplicate monitor.html must NOT be emitted into dist-extension",
    );

    // Verify duplicate monitor bundles are absent and mediabunny library is strictly
    // isolated to offscreen (0 occurrences in background.js and all non-offscreen JS)
    const assetEntries = await readdir(join(prodOut, "assets"));
    const sidepanelBundles = assetEntries.filter((f) =>
      /^sidepanel-.*\.js$/.test(f),
    );
    const monitorBundles = assetEntries.filter((f) =>
      /^monitor-.*\.js$/i.test(f),
    );
    assert.ok(sidepanelBundles.length > 0, "expected assets/sidepanel-*.js");
    assert.equal(
      monitorBundles.length,
      0,
      "duplicate assets/monitor-*.js must NOT be emitted into dist-extension",
    );
    const strictEntryFiles = [
      "background.js",
      ...sidepanelBundles.map((f) => `assets/${f}`),
    ];
    for (const rel of strictEntryFiles) {
      const code = await readFile(join(prodOut, rel), "utf8");
      assert.equal(
        /\bMp4OutputFormat\b/.test(code),
        false,
        `${rel} must not contain Mp4OutputFormat`,
      );
      assert.equal(
        /MediabunnyVideoHandler|MediabunnySoundHandler|mediabunny loaded|Mediabunny Codec Registry/.test(
          code,
        ),
        false,
        `${rel} must not bundle Mediabunny library`,
      );
    }
    const nonOffscreenAssetJs = assetEntries.filter(
      (f) => f.endsWith(".js") && !/^offscreen-.*\.js$/i.test(f),
    );
    for (const rel of nonOffscreenAssetJs.map((f) => `assets/${f}`)) {
      const code = await readFile(join(prodOut, rel), "utf8");
      assert.equal(
        /MediabunnyVideoHandler|MediabunnySoundHandler|mediabunny loaded|Mediabunny Codec Registry/.test(
          code,
        ),
        false,
        `${rel} must not bundle Mediabunny library`,
      );
    }

    // --dev-loopback merges loopback into host_permissions ONLY for local headless testing
    const devBuilt = await buildExtension({
      devLoopback: true,
      outDir: devOut,
      quiet: true,
    });
    assert.equal(
      devBuilt.manifest.host_permissions.includes("http://127.0.0.1/*"),
      true,
    );
    assert.equal(
      devBuilt.manifest.host_permissions.includes("http://localhost/*"),
      true,
    );
    assert.deepEqual(devBuilt.manifest.optional_host_permissions, []);
    assert.equal(devBuilt.manifest.key, DOKITOOL_EXTENSION_MANIFEST_KEY);
    assert.deepEqual(devBuilt.manifest.externally_connectable, {
      matches: DEV_LOOPBACK_EXTERNALLY_CONNECTABLE_MATCHES,
    });

    // A --dev-loopback build MUST be rejected by the production security gate!
    await assert.rejects(
      () => verifyExtensionDist(devOut, { devLoopback: false }),
      /127\.0\.0\.1|localhost|externally_connectable/,
    );

    // Tampering with key, externally_connectable, permissions, <all_urls>, content_scripts, or external scripts MUST fail verifyExtensionDist!
    const manifestPath = join(prodOut, "manifest.json");
    const origManifestText = await readFile(manifestPath, "utf8");

    await writeFile(
      manifestPath,
      JSON.stringify({ ...prodManifest, key: undefined }),
      "utf8",
    );
    await assert.rejects(
      () => verifyExtensionDist(prodOut, { devLoopback: false }),
      /key/,
    );

    await writeFile(
      manifestPath,
      JSON.stringify({ ...prodManifest, key: "AAAA" }),
      "utf8",
    );
    await assert.rejects(
      () => verifyExtensionDist(prodOut, { devLoopback: false }),
      /key|extension ID/,
    );

    await writeFile(
      manifestPath,
      JSON.stringify({
        ...prodManifest,
        externally_connectable: { matches: ["https://snap.dokitool.com/*", "http://127.0.0.1/*"] },
      }),
      "utf8",
    );
    await assert.rejects(
      () => verifyExtensionDist(prodOut, { devLoopback: false }),
      /externally_connectable/,
    );

    await writeFile(
      manifestPath,
      JSON.stringify({
        ...prodManifest,
        externally_connectable: { matches: ["https://*.dokitool.com/*"] },
      }),
      "utf8",
    );
    await assert.rejects(
      () => verifyExtensionDist(prodOut, { devLoopback: false }),
      /externally_connectable/,
    );

    await writeFile(
      manifestPath,
      JSON.stringify({
        ...prodManifest,
        externally_connectable: {
          matches: ["https://snap.dokitool.com/*"],
          ids: ["*"],
        },
      }),
      "utf8",
    );
    await assert.rejects(
      () => verifyExtensionDist(prodOut, { devLoopback: false }),
      /externally_connectable\.ids/,
    );

    await writeFile(
      manifestPath,
      JSON.stringify({
        ...prodManifest,
        permissions: [...prodManifest.permissions, "cookies"],
      }),
      "utf8",
    );
    await assert.rejects(
      () => verifyExtensionDist(prodOut, { devLoopback: false }),
      /cookies/,
    );

    await writeFile(
      manifestPath,
      JSON.stringify({
        ...prodManifest,
        host_permissions: [...prodManifest.host_permissions, "<all_urls>"],
      }),
      "utf8",
    );
    await assert.rejects(
      () => verifyExtensionDist(prodOut, { devLoopback: false }),
      /<all_urls>/,
    );

    await writeFile(manifestPath, origManifestText, "utf8");

    const sidepanelHtmlPath = join(prodOut, "sidepanel.html");
    const origSidepanelHtml = await readFile(sidepanelHtmlPath, "utf8");
    await writeFile(
      sidepanelHtmlPath,
      `${origSidepanelHtml}\n<script src="https://cdn.example.com/tracker.js"></script>\n`,
      "utf8",
    );
    await assert.rejects(
      () => verifyExtensionDist(prodOut, { devLoopback: false }),
      /External script URL/,
    );
    await writeFile(sidepanelHtmlPath, origSidepanelHtml, "utf8");

    // Tampering sidepanel bundle or background.js with Mp4OutputFormat MUST fail verifyExtensionDist mediabunny isolation gate
    const firstSidepanelBundlePath = join(prodOut, "assets", sidepanelBundles[0]);
    const origSidepanelJs = await readFile(firstSidepanelBundlePath, "utf8");
    await writeFile(
      firstSidepanelBundlePath,
      `${origSidepanelJs}\n/* Mp4OutputFormat */\n`,
      "utf8",
    );
    await assert.rejects(
      () => verifyExtensionDist(prodOut, { devLoopback: false }),
      /Mediabunny isolation violation/,
    );
    await writeFile(firstSidepanelBundlePath, origSidepanelJs, "utf8");

    const backgroundJsPath = join(prodOut, "background.js");
    const origBackgroundJs = await readFile(backgroundJsPath, "utf8");
    await writeFile(
      backgroundJsPath,
      `${origBackgroundJs}\n/* Mp4OutputFormat */\n`,
      "utf8",
    );
    await assert.rejects(
      () => verifyExtensionDist(prodOut, { devLoopback: false }),
      /Mediabunny isolation violation/,
    );
    await writeFile(backgroundJsPath, origBackgroundJs, "utf8");

    // Re-introducing duplicate monitor.html or assets/monitor-*.js MUST fail verifyExtensionDist
    const strayMonitorHtml = join(prodOut, "monitor.html");
    await writeFile(strayMonitorHtml, "<!doctype html><html></html>\n", "utf8");
    await assert.rejects(
      () => verifyExtensionDist(prodOut, { devLoopback: false }),
      /Forbidden duplicate monitor\.html/,
    );
    await rm(strayMonitorHtml, { force: true });

    const strayMonitorJs = join(prodOut, "assets", "monitor-deadbeef.js");
    await writeFile(strayMonitorJs, "console.log('monitor');\n", "utf8");
    await assert.rejects(
      () => verifyExtensionDist(prodOut, { devLoopback: false }),
      /Forbidden duplicate monitor bundle/,
    );
    await rm(strayMonitorJs, { force: true });
  } finally {
    await rm(prodOut, { recursive: true, force: true });
    await rm(devOut, { recursive: true, force: true });
  }
});

test("build-extension.mjs: deterministic ZIP writer, root manifest.json, byte-for-byte verification, and --dev-loopback refusal", async () => {
  const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

  // 1. createDeterministicZipBuffer is OS/order/time-independent with fixed DOS timestamp & UTF-8 flag
  const sampleA = [
    { path: "z/file.txt", data: "hello world\n".repeat(40) },
    { path: "a/alpha.json", data: '{"ok":true}\n' },
    { path: "manifest.json", data: '{"manifest_version":3}\n' },
  ];
  const sampleB = [...sampleA].reverse();
  const bufA = createDeterministicZipBuffer(sampleA);
  const bufB = createDeterministicZipBuffer(sampleB);
  assert.equal(sha256(bufA), sha256(bufB), "reversed input order must produce byte-identical ZIP");
  assert.equal(bufA.readUInt32LE(0), 0x04034b50, "must begin with PKZIP local header magic");
  assert.equal(bufA.readUInt16LE(6), 0x0800, "must set UTF-8 general-purpose bit flag");
  assert.equal(bufA.readUInt16LE(10), 0x0000, "must pin fixed DOS time 00:00:00");
  assert.equal(
    bufA.readUInt16LE(12),
    ((2026 - 1980) << 9) | (1 << 5) | 1,
    "must pin fixed DOS date 2026-01-01",
  );

  // Verify entry order is strictly lexicographical by POSIX path
  const parsedSample = await JSZip.loadAsync(bufA);
  assert.deepEqual(Object.keys(parsedSample.files), [
    "a/alpha.json",
    "manifest.json",
    "z/file.txt",
  ]);

  // 2. Full production buildExtension with zipOut + determinism across repeated packageExtensionZip calls
  const tmpBase = await mkdtemp(join(tmpdir(), "dokitool-ext-zip-test-"));
  const prodOut = join(tmpBase, "dist-extension");
  const zipPath1 = join(tmpBase, "out", "dokitool-chrome-extension.zip");
  const zipPath2 = join(tmpBase, "out", "dokitool-chrome-extension-repeat.zip");
  const devOut = join(tmpBase, "dist-extension-dev");
  const devZipPath = join(tmpBase, "out", "dev-loopback-forbidden.zip");
  try {
    const built = await buildExtension({
      devLoopback: false,
      outDir: prodOut,
      zipOut: zipPath1,
      quiet: true,
    });
    assert.ok(built.zip, "buildExtension with zipOut must return zip metadata");
    assert.equal(existsSync(zipPath1), true);
    assert.equal(built.zip.zipPath, resolve(zipPath1));
    assert.ok(built.zip.sizeBytes > 0);
    assert.match(built.zip.sha256, /^[0-9a-f]{64}$/);

    // Verify ZIP has manifest.json directly at archive root (no wrapping folder) and matches every file byte-for-byte
    const verified = await verifyExtensionZip(zipPath1, prodOut);
    assert.equal(verified.sha256, built.zip.sha256);
    assert.equal(verified.manifest.manifest_version, 3);
    const parsedZip = await JSZip.loadAsync(await readFile(zipPath1));
    assert.ok(parsedZip.files["manifest.json"], "manifest.json must sit directly at ZIP root");
    assert.ok(parsedZip.files["background.js"], "background.js must sit directly at ZIP root");
    assert.ok(parsedZip.files["sidepanel.html"], "sidepanel.html must sit directly at ZIP root");
    assert.equal(
      parsedZip.files["monitor.html"],
      undefined,
      "duplicate monitor.html must NOT exist in extension ZIP",
    );
    assert.equal(
      Object.keys(parsedZip.files).some((name) =>
        /^assets\/monitor-.*\.js$/i.test(name),
      ),
      false,
      "duplicate assets/monitor-*.js must NOT exist in extension ZIP",
    );
    assert.ok(parsedZip.files["offscreen.html"], "offscreen.html must sit directly at ZIP root");
    assert.ok(parsedZip.files["icons/icon-128.png"], "icons/icon-128.png must sit at root icons/");

    // Packaging the same built directory twice yields identical SHA-256
    const repacked = await packageExtensionZip(prodOut, zipPath2);
    assert.equal(
      repacked.sha256,
      built.zip.sha256,
      "repeated packageExtensionZip calls must emit 100% identical SHA-256",
    );

    // 3. Security guard: devLoopback=true combined with zipOut MUST throw and refuse to emit a ZIP
    await assert.rejects(
      () =>
        buildExtension({
          devLoopback: true,
          outDir: devOut,
          zipOut: devZipPath,
          quiet: true,
        }),
      /--dev-loopback/,
    );
    assert.equal(
      existsSync(devZipPath),
      false,
      "dev-loopback refusal must not create a ZIP file",
    );

    // 4. verifyExtensionZip rejects a ZIP that wraps manifest.json in a subdirectory
    const wrappedZipPath = join(tmpBase, "wrapped.zip");
    const manifestBytes = await readFile(join(prodOut, "manifest.json"));
    const wrappedBuf = createDeterministicZipBuffer([
      { path: "dokitool-chrome-extension/manifest.json", data: manifestBytes },
    ]);
    await writeFile(wrappedZipPath, wrappedBuf);
    await assert.rejects(
      () => verifyExtensionZip(wrappedZipPath),
      /manifest\.json directly at archive root/,
    );

    // 5. verifyExtensionZip rejects a ZIP containing a tampered production manifest (e.g. loopback host)
    const badManifestZipPath = join(tmpBase, "bad-manifest.zip");
    const badManifest = {
      ...built.manifest,
      host_permissions: [...built.manifest.host_permissions, "http://127.0.0.1/*"],
    };
    const badZipEntries = [];
    for (const [name, entry] of Object.entries(parsedZip.files)) {
      badZipEntries.push({
        path: name,
        data:
          name === "manifest.json"
            ? Buffer.from(JSON.stringify(badManifest, null, 2) + "\n", "utf8")
            : await entry.async("nodebuffer"),
      });
    }
    await writeFile(badManifestZipPath, createDeterministicZipBuffer(badZipEntries));
    await assert.rejects(
      () => verifyExtensionZip(badManifestZipPath),
      /127\.0\.0\.1|localhost/,
    );

    // 6. verifyExtensionZip rejects a ZIP containing stray monitor.html or assets/monitor-*.js
    const baseZipEntries = [];
    for (const [name, entry] of Object.entries(parsedZip.files)) {
      baseZipEntries.push({
        path: name,
        data: await entry.async("nodebuffer"),
      });
    }
    const strayMonitorHtmlZip = join(tmpBase, "stray-monitor-html.zip");
    await writeFile(
      strayMonitorHtmlZip,
      createDeterministicZipBuffer([
        ...baseZipEntries,
        { path: "monitor.html", data: "<!doctype html><html></html>\n" },
      ]),
    );
    await assert.rejects(
      () => verifyExtensionZip(strayMonitorHtmlZip),
      /Forbidden duplicate monitor\.html/,
    );

    const strayMonitorJsZip = join(tmpBase, "stray-monitor-js.zip");
    await writeFile(
      strayMonitorJsZip,
      createDeterministicZipBuffer([
        ...baseZipEntries,
        { path: "assets/monitor-deadbeef.js", data: "console.log('monitor');\n" },
      ]),
    );
    await assert.rejects(
      () => verifyExtensionZip(strayMonitorJsZip),
      /Forbidden duplicate monitor bundle/,
    );
  } finally {
    await rm(tmpBase, { recursive: true, force: true });
  }
});

test("check-public-files.py: strictly rejects frontend/dist-extension/* from public inventory", async () => {
  const repoRoot = resolve(
    fileURLToPath(new URL("../..", import.meta.url)),
  );
  const checkScriptSrc = join(repoRoot, "scripts", "check-public-files.py");
  const tmpRepo = await mkdtemp(join(tmpdir(), "dokitool-pubfiles-gate-"));

  try {
    await mkdir(join(tmpRepo, "scripts"), { recursive: true });
    await mkdir(join(tmpRepo, "frontend", "dist-extension"), {
      recursive: true,
    });
    await copyFile(
      checkScriptSrc,
      join(tmpRepo, "scripts", "check-public-files.py"),
    );
    await writeFile(
      join(tmpRepo, "frontend", "dist-extension", "manifest.json"),
      '{"manifest_version":3}\n',
      "utf8",
    );
    await writeFile(
      join(tmpRepo, "public-files.json"),
      JSON.stringify(
        { files: ["frontend/dist-extension/manifest.json"] },
        null,
        2,
      ) + "\n",
      "utf8",
    );

    const pythonCandidates = [
      process.env.PYTHON,
      "/opt/homebrew/bin/python3.10",
      "python3",
      "python",
    ].filter(Boolean);
    const pythonBin =
      pythonCandidates.find((bin) => {
        const probe = spawnSync(bin, ["--version"], { encoding: "utf8" });
        return probe.status === 0;
      }) || "python3";

    const res = spawnSync(
      pythonBin,
      ["-B", join(tmpRepo, "scripts", "check-public-files.py"), "--write-ignore"],
      {
        cwd: tmpRepo,
        encoding: "utf8",
      },
    );
    assert.notEqual(
      res.status,
      0,
      "check-public-files.py must reject frontend/dist-extension/*",
    );
    assert.match(
      `${res.stdout || ""}\n${res.stderr || ""}`,
      /Local\/generated directory in inventory: frontend\/dist-extension\/manifest\.json/,
    );
  } finally {
    await rm(tmpRepo, { recursive: true, force: true });
  }
});

test("urlMatcher P1/P2/P3 hardening: positive feed suppression, backend-supported work URLs, and canonical dedupeKey parity", () => {
  // P1: Non-work/profile/login/feed pages on facebook, tumblr, and toutiao must return isLikelyFeedOrHome: true
  const p1FeedCases = [
    ["facebook", "https://www.facebook.com/"],
    ["facebook", "https://www.facebook.com/home.php"],
    ["facebook", "https://www.facebook.com/watch"],
    ["facebook", "https://www.facebook.com/friends"],
    ["facebook", "https://www.facebook.com/marketplace/"],
    ["facebook", "https://www.facebook.com/login/"],
    ["facebook", "https://www.facebook.com/notifications"],
    ["facebook", "https://www.facebook.com/groups"],
    ["facebook", "https://www.facebook.com/groups/123456789/"],
    ["facebook", "https://www.facebook.com/messages"],
    ["facebook", "https://www.facebook.com/settings"],
    ["facebook", "https://fb.watch/"],
    ["tumblr", "https://www.tumblr.com/"],
    ["tumblr", "https://www.tumblr.com/maskofthedragon"],
    ["tumblr", "https://maskofthedragon.tumblr.com/"],
    ["tumblr", "https://www.tumblr.com/blog/view/maskofthedragon"],
    ["tumblr", "https://www.tumblr.com/tagged/2024"],
    ["tumblr", "https://www.tumblr.com/search/12345"],
    ["tumblr", "https://www.tumblr.com/login"],
    ["toutiao", "https://www.toutiao.com/"],
    ["toutiao", "https://www.toutiao.com/ch/news_tech/"],
    ["toutiao", "https://www.toutiao.com/c/user/token/MS4wLjAB/"],
  ];

  for (const [expectedPlatform, url] of p1FeedCases) {
    const matched = urlMatcher.matchSupportedPlatformUrl(url);
    assert.ok(matched, `expected platform match for ${url}`);
    assert.equal(matched.platform, expectedPlatform, `platform mismatch for ${url}`);
    assert.equal(
      matched.isLikelyFeedOrHome,
      true,
      `P1: expected isLikelyFeedOrHome=true for ${url}`,
    );
  }

  // P1 positive work URLs on facebook, tumblr, and toutiao must remain isLikelyFeedOrHome: false
  const p1WorkCases = [
    ["facebook", "https://www.facebook.com/someuser/posts/10159876543210/", "facebook:post:10159876543210"],
    ["facebook", "https://www.facebook.com/groups/12345/posts/67890/", "facebook:post:67890"],
    ["facebook", "https://www.facebook.com/permalink.php?story_fbid=pfbid02abcXYZ&id=100", "facebook:post:pfbid02abcXYZ"],
    ["tumblr", "https://www.tumblr.com/maskofthedragon/626907179849564160/mona", "tumblr:post:626907179849564160"],
    ["toutiao", "https://m.toutiao.com/is/iAbCdEfG/", "toutiao:short:iAbCdEfG"],
  ];
  for (const [expectedPlatform, url, expectedKey] of p1WorkCases) {
    const matched = urlMatcher.matchSupportedPlatformUrl(url);
    assert.ok(matched, `expected match for ${url}`);
    assert.equal(matched.platform, expectedPlatform);
    assert.equal(matched.isLikelyFeedOrHome, false, `expected work URL for ${url}`);
    assert.equal(matched.dedupeKey, expectedKey, `dedupeKey mismatch for ${url}`);
  }

  // P2: Backend-supported work URLs that previously false-flagged isLikelyFeedOrHome: true
  const p2WorkCases = [
    ["xiaohongshu", "https://www.xiaohongshu.com/note/66aabbccdd11223344556677", "xiaohongshu:note:66aabbccdd11223344556677"],
    ["xiaohongshu", "https://www.xiaohongshu.com/item/66aabbccdd11223344556677", "xiaohongshu:note:66aabbccdd11223344556677"],
    ["kuaishou", "https://www.kuaishou.com/long-video/3xngkmw8vacriqu", "kuaishou:item:3xngkmw8vacriqu"],
    ["kuaishou", "https://m.kuaishou.com/photo/3xngkmw8vacriqu", "kuaishou:item:3xngkmw8vacriqu"],
    ["douyin", "https://www.douyin.com/video/7704056737233449610.html", "douyin:item:7704056737233449610"],
    ["douyin", "https://www.douyin.com/share/video/?vid=7704056737233449610", "douyin:item:7704056737233449610"],
    ["bilibili", "https://www.bilibili.com/festival/2024?bvid=BV1uv411q7Mv", "bilibili:video:BV1uv411q7Mv:p=1"],
    ["bilibili", "https://www.bilibili.com/list/watchlater?bvid=BV1uv411q7Mv&p=2", "bilibili:video:BV1uv411q7Mv:p=2"],
    ["toutiao", "https://www.toutiao.com/?group_id=7501991960077500979", "toutiao:item:7501991960077500979"],
    ["toutiao", "https://www.toutiao.com/?item_id=7501991960077500979", "toutiao:item:7501991960077500979"],
  ];

  for (const [expectedPlatform, url, expectedKey] of p2WorkCases) {
    const matched = urlMatcher.matchSupportedPlatformUrl(url);
    assert.ok(matched, `P2: expected match for ${url}`);
    assert.equal(matched.platform, expectedPlatform);
    assert.equal(
      matched.isLikelyFeedOrHome,
      false,
      `P2: expected isLikelyFeedOrHome=false for ${url}`,
    );
    assert.equal(matched.dedupeKey, expectedKey, `P2: dedupeKey mismatch for ${url}`);
  }

  // P3: Canonical dedupeKey polish
  // 1) Facebook /share/v/<id>, /share/r/<id>, /video.php?v=<id>
  const fbShareV = urlMatcher.matchSupportedPlatformUrl(
    "https://www.facebook.com/share/v/1AbCdEfGhI/?mibextid=wwXIfr",
  );
  const fbShareR = urlMatcher.matchSupportedPlatformUrl(
    "https://m.facebook.com/share/r/1ZyXwVuTsR/",
  );
  const fbVideoPhp = urlMatcher.matchSupportedPlatformUrl(
    "https://www.facebook.com/video.php?v=401590806345712",
  );
  const fbWatch = urlMatcher.matchSupportedPlatformUrl(
    "https://www.facebook.com/watch/?v=401590806345712",
  );
  assert.equal(fbShareV?.dedupeKey, "facebook:share:v:1AbCdEfGhI");
  assert.equal(fbShareV?.isLikelyFeedOrHome, false);
  assert.equal(fbShareR?.dedupeKey, "facebook:share:r:1ZyXwVuTsR");
  assert.equal(fbShareR?.isLikelyFeedOrHome, false);
  assert.equal(fbVideoPhp?.dedupeKey, "facebook:video:401590806345712");
  assert.equal(fbVideoPhp?.dedupeKey, fbWatch?.dedupeKey);
  assert.equal(fbVideoPhp?.isLikelyFeedOrHome, false);

  // 2) Tumblr www.tumblr.com/blog/view/<blog>/<id> & subdomain pagination/archive filtering
  const tumblrBlogView = urlMatcher.matchSupportedPlatformUrl(
    "https://www.tumblr.com/blog/view/maskofthedragon/626907179849564160",
  );
  const tumblrPost = urlMatcher.matchSupportedPlatformUrl(
    "https://maskofthedragon.tumblr.com/post/626907179849564160/mona",
  );
  const tumblrRootBlogPost = urlMatcher.matchSupportedPlatformUrl(
    "https://www.tumblr.com/maskofthedragon/626907179849564160/mona",
  );
  assert.equal(tumblrBlogView?.dedupeKey, "tumblr:post:626907179849564160");
  assert.equal(tumblrBlogView?.dedupeKey, tumblrPost?.dedupeKey);
  assert.equal(tumblrRootBlogPost?.dedupeKey, tumblrPost?.dedupeKey);
  assert.equal(tumblrBlogView?.isLikelyFeedOrHome, false);
  assert.equal(tumblrRootBlogPost?.isLikelyFeedOrHome, false);
  for (const tumblrNonWorkUrl of [
    "https://staff.tumblr.com/page/2",
    "https://staff.tumblr.com/day/2026/01/01",
    "https://staff.tumblr.com/archive/2026",
    "https://www.tumblr.com/page/2",
    "https://www.tumblr.com/day/2026",
    "https://www.tumblr.com/archive/2026",
  ]) {
    const nonWork = urlMatcher.matchSupportedPlatformUrl(tumblrNonWorkUrl);
    assert.ok(nonWork, `expected Tumblr host match for ${tumblrNonWorkUrl}`);
    assert.equal(nonWork.platform, "tumblr");
    assert.equal(
      nonWork.isLikelyFeedOrHome,
      true,
      `expected isLikelyFeedOrHome=true for ${tumblrNonWorkUrl}`,
    );
  }

  // 3) Pipixia ?item_id=<id>
  const ppxQuery = urlMatcher.matchSupportedPlatformUrl(
    "https://h5.pipix.com/?item_id=7385813877985909043",
  );
  const ppxPath = urlMatcher.matchSupportedPlatformUrl(
    "https://h5.pipix.com/item/7385813877985909043",
  );
  assert.equal(ppxQuery?.dedupeKey, "pipixia:item:7385813877985909043");
  assert.equal(ppxQuery?.dedupeKey, ppxPath?.dedupeKey);
  assert.equal(ppxQuery?.isLikelyFeedOrHome, false);

  // 4) Zuiyou nested /detail/<id>
  const zuiyouNested = urlMatcher.matchSupportedPlatformUrl(
    "https://share.izuiyou.com/hybrid/detail/163566379",
  );
  const zuiyouPid = urlMatcher.matchSupportedPlatformUrl(
    "https://share.xiaochuankeji.cn/hybrid/share/post?pid=163566379",
  );
  assert.equal(zuiyouNested?.dedupeKey, "zuiyou:post:163566379");
  assert.equal(zuiyouNested?.dedupeKey, zuiyouPid?.dedupeKey);
  assert.equal(zuiyouNested?.isLikelyFeedOrHome, false);

  // 5) Weibo: /detail/<id> and /status/<id> restricted strictly to m.weibo.cn
  const mWeiboDetail = urlMatcher.matchSupportedPlatformUrl(
    "https://m.weibo.cn/detail/5012345678901234",
  );
  const mWeiboStatus = urlMatcher.matchSupportedPlatformUrl(
    "https://m.weibo.cn/status/5012345678901234",
  );
  const pcWeiboUidMid = urlMatcher.matchSupportedPlatformUrl(
    "https://weibo.com/1234567890/OqAbCdEfG",
  );
  const pcWeiboDetailRejected = urlMatcher.matchSupportedPlatformUrl(
    "https://weibo.com/detail/5012345678901234",
  );
  const pcWeiboStatusRejected = urlMatcher.matchSupportedPlatformUrl(
    "https://www.weibo.com/status/5012345678901234",
  );
  assert.equal(mWeiboDetail?.dedupeKey, "weibo:status:5012345678901234");
  assert.equal(mWeiboDetail?.isLikelyFeedOrHome, false);
  assert.equal(mWeiboStatus?.dedupeKey, "weibo:status:5012345678901234");
  assert.equal(mWeiboStatus?.isLikelyFeedOrHome, false);
  assert.equal(pcWeiboUidMid?.dedupeKey, "weibo:status:OqAbCdEfG");
  assert.equal(pcWeiboUidMid?.isLikelyFeedOrHome, false);
  assert.equal(pcWeiboDetailRejected?.isLikelyFeedOrHome, true);
  assert.notEqual(pcWeiboDetailRejected?.dedupeKey, "weibo:status:5012345678901234");
  assert.equal(pcWeiboStatusRejected?.isLikelyFeedOrHome, true);
  assert.notEqual(pcWeiboStatusRejected?.dedupeKey, "weibo:status:5012345678901234");
});

test("Bilibili DASH security boundary: hostWhitelist & DNR Rule 1004 permit official DASH CDNs with zero Cookie + Bilibili Referer while rejecting third-party PCDN", () => {
  // Official Bilibili DASH CDNs allowed
  for (const allowedUrl of [
    "https://upos-sz-mirrorcos.bilivideo.com/upgcxcode/12/34/56-1-100024.m4s",
    "https://upos-sz-mirrorali.bilivideo.com/upgcxcode/12/34/56-1-30280.m4s",
    "https://xy123x45x67x89xy.mcdn.bilivideo.cn/v1/resource/56-1-100024.m4s",
    "https://upos-hz-mirrorakam.akamaized.net/upgcxcode/12/34/56-1-100024.m4s",
  ]) {
    const res = hostWhitelist.isWhitelistedMediaUrl(allowedUrl);
    assert.equal(res.allowed, true, `official Bilibili DASH URL must be allowed: ${allowedUrl}`);
  }

  // Third-party PCDN & non-standard hosts strictly rejected
  for (const blockedUrl of [
    "https://w9e959o.edge.mountaintoys.cn/v1/resource/56-1-100024.m4s",
    "https://112-23-45-67.pcdn.example.net/stream.m4s",
    "https://183.240.12.34/stream.m4s",
    "https://upos-sz-mirrorcos.bilivideo.com:8443/stream.m4s",
  ]) {
    const res = hostWhitelist.isWhitelistedMediaUrl(blockedUrl);
    assert.equal(res.allowed, false, `PCDN/non-standard URL must be blocked: ${blockedUrl}`);
  }

  // DNR Rule 1004 injects Referer: https://www.bilibili.com/ for domestic Bilibili domains while Rules 1006-1008 narrow Akamai UPOS
  const rules = dnrRules.buildExtensionDnrRules("abcdefghijklmnopabcdefghijklmnop");
  const biliRule = rules.find((r) => r.id === 1004);
  assert.ok(biliRule, "DNR Rule 1004 must exist for Bilibili DASH");
  assert.deepEqual(biliRule.condition.initiatorDomains, [
    "abcdefghijklmnopabcdefghijklmnop",
  ]);
  for (const domain of ["bilivideo.com", "bilivideo.cn", "hdslb.com"]) {
    assert.ok(
      biliRule.condition.requestDomains.includes(domain),
      `DNR Rule 1004 must cover ${domain}`,
    );
  }
  assert.equal(
    biliRule.condition.requestDomains.includes("akamaized.net"),
    false,
    "G1: akamaized.net must be narrowed to priority-3 Rules 1006-1008",
  );
  assert.deepEqual(biliRule.action.requestHeaders, [
    { header: "Referer", operation: "set", value: "https://www.bilibili.com/" },
    { header: "Origin", operation: "remove" },
    { header: "Cookie", operation: "remove" },
  ]);
  const biliAkamaiRules = rules.filter((r) => r.id >= 1006 && r.id <= 1008);
  assert.equal(biliAkamaiRules.length, 3);
  for (const r of biliAkamaiRules) {
    assert.equal(r.priority, 3);
    assert.deepEqual(r.condition.requestDomains, ["akamaized.net"]);
    assert.deepEqual(r.action.requestHeaders, biliRule.action.requestHeaders);
  }
});

test("PR-C urlMatcher: matchSupportedPlatformUrl stays strict 14-core while matchActiveParseUrl & extractActiveParseUrlsFromText accept long-tail sites and block unsafe/local/bare URLs", () => {
  const longTailSamples = [
    ["https://vimeo.com/123456", "vimeo.com", "generic:url:vimeo.com/123456"],
    [
      "https://www.tiktok.com/@creator/video/7123456789?utm_source=share&is_from_webapp=1#top",
      "tiktok.com",
      "generic:url:www.tiktok.com/@creator/video/7123456789",
    ],
    [
      "https://www.reddit.com/r/videos/comments/abc123/demo/",
      "reddit.com",
      "generic:url:www.reddit.com/r/videos/comments/abc123/demo",
    ],
    [
      "https://soundcloud.com/artist-name/cool-track?si=tracking123",
      "soundcloud.com",
      "generic:url:soundcloud.com/artist-name/cool-track",
    ],
    [
      "https://bandcamp.com/?id=42",
      "bandcamp.com",
      "generic:url:bandcamp.com/?id=42",
    ],
  ];

  for (const [sampleUrl, expectedLabel, expectedDedupe] of longTailSamples) {
    // Privacy firewall core-14 matcher MUST still reject every long-tail site!
    assert.equal(
      urlMatcher.matchSupportedPlatformUrl(sampleUrl),
      null,
      `matchSupportedPlatformUrl must stay strictly 14-core for ${sampleUrl}`,
    );

    const active = urlMatcher.matchActiveParseUrl(sampleUrl);
    assert.ok(active, `matchActiveParseUrl must accept ${sampleUrl}`);
    assert.equal(active.platform, "generic");
    assert.equal(active.platformLabel, expectedLabel);
    assert.equal(active.dedupeKey, expectedDedupe);
    assert.equal(active.isLikelyFeedOrHome, false);
    assert.equal(active.isGeneric, true);
    assert.equal(active.url.includes("#"), false, "fragment must be stripped");
  }

  // Core-14 URLs still delegate directly to matchSupportedPlatformUrl
  const ytCore = urlMatcher.matchActiveParseUrl(
    "https://www.youtube.com/watch?v=I9JvDaciaFk",
  );
  assert.ok(ytCore);
  assert.equal(ytCore.platform, "youtube");
  assert.equal(ytCore.youtubeVideoId, "I9JvDaciaFk");
  assert.equal(ytCore.isGeneric, undefined);

  // Security & hygiene rejections on matchActiveParseUrl
  const longUrl = `https://vimeo.com/${"a".repeat(2040)}`;
  assert.ok(longUrl.length > 2048);
  for (const blockedUrl of [
    "",
    "   ",
    longUrl,
    "chrome://extensions",
    "chrome-extension://abcdefghijklmnopabcdefghijklmnop/sidepanel.html",
    "file:///etc/passwd",
    "about:blank",
    "javascript:alert(1)",
    "http://127.0.0.1/video/1",
    "https://192.168.1.1/video/1",
    "http://0x7f000001/video/1",
    "https://[::1]/video/1",
    "http://localhost/video/1",
    "https://sub.localhost/video/1",
    "https://printer.local/video/1",
    "https://metadata.internal/latest",
    "https://box.localdomain/video/1",
    "https://router.home.arpa/video/1",
    "https://dokitool.com/video/1",
    "https://snap.dokitool.com/api/parse",
    "https://vimeo.com:8443/123456",
    "http://vimeo.com:443/123456",
    "https://user:pass@vimeo.com/123456",
    "https://intranet/video/1",
    "https://vimeo.com",
    "https://vimeo.com/",
    "https://vimeo.com///",
    "https://vimeo.com/#frag",
  ]) {
    assert.equal(
      urlMatcher.matchActiveParseUrl(blockedUrl),
      null,
      `matchActiveParseUrl must reject ${blockedUrl}`,
    );
  }

  // Batch extractor mixes core-14 + long-tail, deduplicates tracking variants, and ignores unsafe/plain lines
  const mixedBatch = [
    "看看这个 B 站视频 https://www.bilibili.com/video/BV1uv411q7Mv?spm_id_from=333",
    "Vimeo 推荐 https://vimeo.com/123456?utm_source=copy",
    "https://vimeo.com/123456",
    "TikTok 分享 https://www.tiktok.com/@creator/video/7123456789?is_from_webapp=1",
    "https://soundcloud.com/artist/track-1",
    "纯文字备注，没有链接",
    "chrome://settings/privacy",
    "file:///Users/demo/secret.mp4",
    "http://192.168.1.10/cam.mp4",
    "http://localhost/admin",
    "https://snap.dokitool.com/api/parse",
    "https://vimeo.com/",
  ].join("\n");

  const extracted = urlMatcher.extractActiveParseUrlsFromText(mixedBatch);
  assert.equal(extracted.items.length, 4);
  assert.deepEqual(
    extracted.items.map((it) => `${it.platform}:${it.platformLabel}`),
    [
      "bilibili:B站",
      "generic:vimeo.com",
      "generic:tiktok.com",
      "generic:soundcloud.com",
    ],
  );
  assert.equal(extracted.duplicateCount, 1);
  assert.equal(extracted.ignoredLineCount, 7);
});

test("PR-C hostWhitelist: PRODUCTION_HOST_PERMISSIONS stays unchanged & isSafeNativeBrowserDownloadUrl enforces public DNS safety", () => {
  // Ensure NO long-tail domains or wildcards were added to PRODUCTION_HOST_PERMISSIONS
  for (const forbiddenSub of [
    "<all_urls>",
    "*://*/*",
    "http://*/*",
    "https://*/*",
    "vimeocdn",
    "tiktokcdn",
    "redd.it",
    "sndcdn",
  ]) {
    assert.equal(
      hostWhitelist.PRODUCTION_HOST_PERMISSIONS.some((p) =>
        p.includes(forbiddenSub),
      ),
      false,
      `PRODUCTION_HOST_PERMISSIONS must not contain ${forbiddenSub}`,
    );
  }

  // Safe public CDN direct file URLs pass
  for (const safeUrl of [
    "https://skyfire.vimeocdn.com/exp=1/video-1080p.mp4",
    "https://v16-webapp.tiktokcdn.com/video/tos/a.mp4",
    "http://v.redd.it/abc123/DASH_720.mp4",
    "https://cf-media.sndcdn.com/track.mp3?Policy=xyz",
    "https://cdn.example.org/@artist/clip.mp4",
  ]) {
    const res = hostWhitelist.isSafeNativeBrowserDownloadUrl(safeUrl);
    assert.equal(
      res.safe,
      true,
      `expected safe native download URL: ${safeUrl} (reason: ${res.reason})`,
    );
  }

  // Extra allowed origin matches loopback / custom API origin
  assert.equal(
    hostWhitelist.isSafeNativeBrowserDownloadUrl(
      "http://127.0.0.1:18080/mock-media.mp4",
      ["http://127.0.0.1:18080"],
    ).safe,
    true,
  );
  assert.equal(
    hostWhitelist.isSafeNativeBrowserDownloadUrl(
      "http://127.0.0.1:18080/mock-media.mp4",
      ["http://127.0.0.1/*"],
    ).safe,
    true,
  );

  // Unsafe URLs rejected strictly
  const over8k = `https://cdn.vimeo.com/${"x".repeat(8200)}.mp4`;
  for (const badUrl of [
    "",
    "   ",
    over8k,
    "https://cdn.vimeo.com/a b.mp4",
    "https://cdn.vimeo.com/a\\b.mp4",
    "https://cdn.vimeo.com:/v.mp4",
    "https://user:pass@cdn.vimeo.com/v.mp4",
    "https://user@cdn.vimeo.com/v.mp4",
    "https://@cdn.vimeo.com/v.mp4",
    "https://cdn.vimeo.com/v.mp4#frag",
    "file:///etc/passwd",
    "chrome://extensions",
    "blob:https://vimeo.com/123",
    "data:video/mp4;base64,AAAA",
    "https://cdn.vimeo.com:8443/v.mp4",
    "http://cdn.vimeo.com:443/v.mp4",
    "http://127.0.0.1:18080/v.mp4",
    "https://192.168.1.1/v.mp4",
    "https://10.0.0.5/v.mp4",
    "https://[::1]/v.mp4",
    "https://localhost/v.mp4",
    "https://sub.localhost/v.mp4",
    "https://nas.local/v.mp4",
    "https://meta.internal/v.mp4",
    "https://box.localdomain/v.mp4",
    "https://router.home.arpa/v.mp4",
    "https://singlelabel/v.mp4",
    "https://dokitool.com/v.mp4",
    "https://snap.dokitool.com/v.mp4",
  ]) {
    const res = hostWhitelist.isSafeNativeBrowserDownloadUrl(badUrl);
    assert.equal(res.safe, false, `expected unsafe native download URL: ${badUrl}`);
  }
});

test("PR-C security static gate: zero v-html / innerHTML anywhere in frontend/src/extension/", async () => {
  const extDir = resolve(
    fileURLToPath(new URL("../src/extension", import.meta.url)),
  );
  async function walk(dir) {
    const out = [];
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        out.push(...(await walk(full)));
      } else if (/\.(ts|js|vue|html)$/.test(entry.name)) {
        out.push(full);
      }
    }
    return out;
  }
  const files = await walk(extDir);
  assert.ok(files.length > 0);
  for (const file of files) {
    const content = await readFile(file, "utf8");
    assert.equal(
      /\bv-html\b|\binnerHTML\b/.test(content),
      false,
      `Forbidden v-html / innerHTML detected in ${file}`,
    );
  }
});

test("PR-C Round 2 (Task 4.4 #2): isSafeNativeBrowserDownloadUrl explicit default-port and mismatched-port enforcement", () => {
  // Explicit scheme-matching default ports normalize cleanly and MUST pass
  for (const safePortUrl of [
    "https://cdn.vimeo.com:443/v.mp4",
    "http://cdn.vimeo.com:80/v.mp4",
  ]) {
    const res = hostWhitelist.isSafeNativeBrowserDownloadUrl(safePortUrl);
    assert.equal(
      res.safe,
      true,
      `expected safe default-port URL ${safePortUrl} (reason: ${res.reason})`,
    );
  }

  // Non-standard or scheme-mismatched ports MUST be rejected
  for (const unsafePortUrl of [
    "https://cdn.vimeo.com:8443/v.mp4",
    "http://cdn.vimeo.com:443/v.mp4",
    "https://cdn.vimeo.com:80/v.mp4",
  ]) {
    const res = hostWhitelist.isSafeNativeBrowserDownloadUrl(unsafePortUrl);
    assert.equal(
      res.safe,
      false,
      `expected rejected port URL ${unsafePortUrl}`,
    );
  }
});

test("PR-C Round 2 (Task 4.4 #3): reserved TLD suffixes (.invalid/.lan/.corp/.intranet/.private) blocked across hostWhitelist and urlMatcher while keeping .test/.example allowed", () => {
  const reservedSubdomainHosts = [
    "app.invalid",
    "nas.lan",
    "git.corp",
    "portal.intranet",
    "vault.private",
  ];
  const reservedBareHosts = [
    "invalid",
    "lan",
    "corp",
    "intranet",
    "private",
  ];

  for (const host of [...reservedSubdomainHosts, ...reservedBareHosts]) {
    assert.equal(
      hostWhitelist.isSafeNativeBrowserDownloadUrl(`https://${host}/v.mp4`).safe,
      false,
      `isSafeNativeBrowserDownloadUrl must reject reserved host ${host}`,
    );
    assert.equal(
      hostWhitelist.validateApiBaseUrl(`https://${host}`).ok,
      false,
      `validateApiBaseUrl must reject reserved host ${host}`,
    );
    assert.equal(
      urlMatcher.matchActiveParseUrl(`https://${host}/video/123`),
      null,
      `matchActiveParseUrl must reject reserved host ${host}`,
    );
  }

  // RFC 2606 .test and .example MUST remain allowed for test/fixture compatibility
  for (const allowedHost of ["media.site.test", "media.site.example"]) {
    assert.equal(
      hostWhitelist.isSafeNativeBrowserDownloadUrl(`https://${allowedHost}/v.mp4`).safe,
      true,
      `isSafeNativeBrowserDownloadUrl must keep ${allowedHost} allowed`,
    );
    assert.equal(
      hostWhitelist.validateApiBaseUrl(`https://${allowedHost}`).ok,
      true,
      `validateApiBaseUrl must keep ${allowedHost} allowed`,
    );
    const matched = urlMatcher.matchActiveParseUrl(`https://${allowedHost}/video/123`);
    assert.ok(
      matched,
      `matchActiveParseUrl must keep ${allowedHost} allowed`,
    );
    assert.equal(matched.platform, "generic");
  }
});

test("PR 1 Web <-> Extension external bridge security: strict origin gate, zero secret leakage, URL whitelist, filename sanitization, task-ownership isolation, and extensionBridge client", async () => {
  assert.equal(protocol.DOKITOOL_EXTENSION_ID, DOKITOOL_EXTENSION_ID);
  assert.equal(extensionBridge.DOKITOOL_EXTENSION_ID, DOKITOOL_EXTENSION_ID);
  assert.equal(
    deriveExtensionIdFromManifestKey(DOKITOOL_EXTENSION_MANIFEST_KEY),
    "ihamkldlkdibleacagiejklpfofapkpo",
  );

  // 1) validateExternalWebSender: prod manifest allows ONLY https://snap.dokitool.com
  const prodManifest = {
    version: "1.2.3",
    externally_connectable: { matches: PROD_EXTERNALLY_CONNECTABLE_MATCHES },
  };
  const devManifest = {
    version: "1.2.3",
    externally_connectable: { matches: DEV_LOOPBACK_EXTERNALLY_CONNECTABLE_MATCHES },
  };

  assert.deepEqual(
    backgroundMod.validateExternalWebSender(
      { origin: "https://snap.dokitool.com", url: "https://snap.dokitool.com/" },
      prodManifest,
    ),
    { allowed: true, origin: "https://snap.dokitool.com", isLoopback: false },
  );

  for (const badSender of [
    null,
    {},
    { origin: "http://snap.dokitool.com", url: "http://snap.dokitool.com/" },
    { origin: "https://evil.snap.dokitool.com", url: "https://evil.snap.dokitool.com/" },
    { origin: "https://snap.dokitool.com.evil.test", url: "https://snap.dokitool.com.evil.test/" },
    { origin: "http://127.0.0.1:5173", url: "http://127.0.0.1:5173/" },
    { origin: "http://localhost:5173", url: "http://localhost:5173/" },
    { origin: "https://snap.dokitool.com", url: "https://evil.example.com/" },
    { id: "otherextensionid1234567890abcdef", origin: "https://snap.dokitool.com", url: "https://snap.dokitool.com/" },
  ]) {
    const check = backgroundMod.validateExternalWebSender(badSender, prodManifest);
    assert.equal(
      check.allowed,
      false,
      `prod validateExternalWebSender must reject ${JSON.stringify(badSender)}`,
    );
  }

  // Dev loopback manifest allows http://127.0.0.1:* and http://localhost:* while still rejecting evil/LAN/HTTPS-loopback
  assert.deepEqual(
    backgroundMod.validateExternalWebSender(
      { origin: "http://127.0.0.1:5173", url: "http://127.0.0.1:5173/result" },
      devManifest,
    ),
    { allowed: true, origin: "http://127.0.0.1:5173", isLoopback: true },
  );
  assert.deepEqual(
    backgroundMod.validateExternalWebSender(
      { origin: "http://localhost:3000", url: "http://localhost:3000/" },
      devManifest,
    ),
    { allowed: true, origin: "http://localhost:3000", isLoopback: true },
  );
  for (const badDevSender of [
    { origin: "https://127.0.0.1:5173", url: "https://127.0.0.1:5173/" },
    { origin: "http://192.168.1.10:5173", url: "http://192.168.1.10:5173/" },
    { origin: "https://evil.example.com", url: "https://evil.example.com/" },
  ]) {
    assert.equal(
      backgroundMod.validateExternalWebSender(badDevSender, devManifest).allowed,
      false,
      `dev validateExternalWebSender must reject ${JSON.stringify(badDevSender)}`,
    );
  }

  // 2) Full BackgroundController onMessageExternal RPC security verification
  const localArea = storage.createMemoryStorageArea();
  const sessionArea = storage.createMemoryStorageArea();
  const extStore = storage.createExtensionStorage({
    local: localArea,
    session: sessionArea,
  });
  await extStore.updateSettings({
    bearerToken: "doki_top_secret_token_never_leak",
    apiBaseUrl: "https://snap.dokitool.com",
    subfolderPrefix: "DokiClips",
  });

  const externalListeners = [];
  const offscreenMessages = [];
  const dispatchedDownloads = [];
  const mockChrome = {
    runtime: {
      id: DOKITOOL_EXTENSION_ID,
      getManifest: () => prodManifest,
      getURL: (p) => `chrome-extension://${DOKITOOL_EXTENSION_ID}/${p}`,
      onMessage: { addListener() {}, removeListener() {} },
      onMessageExternal: {
        addListener(fn) { externalListeners.push(fn); },
        removeListener(fn) {
          const i = externalListeners.indexOf(fn);
          if (i >= 0) externalListeners.splice(i, 1);
        },
      },
      onConnect: { addListener() {} },
      onInstalled: { addListener() {} },
      onStartup: { addListener() {} },
      sendMessage: async (msg) => {
        offscreenMessages.push(msg);
        if (msg?.type === "OFFSCREEN_PING") return { ok: true };
        return { ok: true };
      },
      getContexts: async () => [{ contextType: "OFFSCREEN_DOCUMENT" }],
    },
    declarativeNetRequest: {
      getDynamicRules: async () => [],
      updateDynamicRules: async () => {},
    },
    downloads: {
      download: async (opts) => {
        dispatchedDownloads.push(opts);
        return dispatchedDownloads.length;
      },
      onChanged: { addListener() {}, removeListener() {} },
    },
    offscreen: {
      createDocument: async () => {},
      closeDocument: async () => {},
    },
    tabs: {
      onActivated: { addListener() {} },
      onUpdated: { addListener() {} },
      onRemoved: { addListener() {} },
    },
    action: {
      setBadgeText: async () => {},
      setBadgeBackgroundColor: async () => {},
    },
  };

  const bg = backgroundMod.createBackgroundController({
    chrome: mockChrome,
    storage: extStore,
  });

  const sendExternal = (msg, sender = { origin: "https://snap.dokitool.com", url: "https://snap.dokitool.com/" }) =>
    new Promise((resolveResp) => {
      assert.equal(externalListeners.length, 1, "background must register chrome.runtime.onMessageExternal");
      externalListeners[0](msg, sender, (resp) => resolveResp(resp));
    });

  try {
    // Unauthorized sender rejected with FORBIDDEN_ORIGIN
    const evilPing = await sendExternal(
      { type: "WEB_EXT_PING" },
      { origin: "https://evil.example.com", url: "https://evil.example.com/" },
    );
    assert.equal(evilPing.ok, false);
    assert.equal(evilPing.code, "FORBIDDEN_ORIGIN");

    // Unsupported/internal actions rejected with UNSUPPORTED_ACTION
    for (const forbiddenMsg of [
      { type: "GET_INITIAL_STATE" },
      { type: "SAVE_SETTINGS", patch: { bearerToken: "hijack" } },
      { type: "FETCH_OWNER_STATS" },
    ]) {
      const resp = await sendExternal(forbiddenMsg);
      assert.equal(resp.ok, false);
      assert.equal(resp.code, "UNSUPPORTED_ACTION");
      assert.equal(
        JSON.stringify(resp).includes("doki_top_secret_token_never_leak"),
        false,
      );
    }

    // WEB_EXT_PING returns strictly scoped version/extensionId/capabilities/useSaveFilePicker & zero secrets
    const pingResp = await sendExternal({ type: "WEB_EXT_PING" });
    assert.deepEqual(pingResp, {
      ok: true,
      data: {
        version: "1.2.3",
        extensionId: DOKITOOL_EXTENSION_ID,
        capabilities: [
          "dash_mux",
          "direct_download",
          "youtube_parse",
          "youtube_mux",
        ],
        useSaveFilePicker: false,
      },
    });
    assert.equal(
      JSON.stringify(pingResp).includes("doki_top_secret_token_never_leak"),
      false,
    );

    // WEB_EXT_ENQUEUE_MEDIA rejects unwhitelisted/PCDN URLs
    const badDashResp = await sendExternal({
      type: "WEB_EXT_ENQUEUE_MEDIA",
      payload: {
        kind: "dash_mux",
        platform: "bilibili",
        title: "PCDN Attack",
        filename: "attack.mp4",
        dashMux: {
          videoRoutes: ["https://w9e959o.edge.mountaintoys.cn/v1/stream.m4s"],
          audioRoutes: ["https://upos-sz-mirrorcos.bilivideo.com/audio.m4s"],
          outputContainer: "mp4",
        },
      },
    });
    assert.equal(badDashResp.ok, false);
    assert.equal(badDashResp.code, "UNWHITELISTED_CDN");

    const badDirectResp = await sendExternal({
      type: "WEB_EXT_ENQUEUE_MEDIA",
      payload: {
        kind: "direct_download",
        platform: "bilibili",
        title: "Evil Host",
        filename: "evil.m4a",
        routes: ["https://evil.example.com/secret.m4a"],
      },
    });
    assert.equal(badDirectResp.ok, false);
    assert.equal(badDirectResp.code, "UNWHITELISTED_CDN");

    // WEB_EXT_ENQUEUE_MEDIA accepts whitelisted DASH mux and sanitizes traversal/reserved filename
    const enqueueDashResp = await sendExternal({
      type: "WEB_EXT_ENQUEUE_MEDIA",
      payload: {
        kind: "dash_mux",
        platform: "bilibili",
        title: "B站单P 1080p 测试",
        filename: "../../CON.mp4",
        dashMux: {
          videoRoutes: ["https://upos-sz-mirrorcos.bilivideo.com/v-1080.m4s"],
          audioRoutes: ["https://upos-sz-mirrorcos.bilivideo.com/a-30280.m4s"],
          videoSize: 20_000_000,
          audioSize: 3_000_000,
          outputContainer: "mp4",
        },
      },
    });
    assert.equal(enqueueDashResp.ok, true);
    assert.ok(enqueueDashResp.data.taskId);
    const webDashTaskId = enqueueDashResp.data.taskId;

    // WEB_EXT_GET_TASK_STATUS returns ONLY sanitized progress fields for web-bridge task
    const dashStatus = await sendExternal({
      type: "WEB_EXT_GET_TASK_STATUS",
      taskId: webDashTaskId,
    });
    assert.equal(dashStatus.ok, true);
    assert.equal(dashStatus.data.taskId, webDashTaskId);
    assert.ok(dashStatus.data.filename.endsWith(".mp4"), "dash_mux must enforce .mp4 extension");
    assert.equal(dashStatus.data.filename.includes(".."), false, "must sanitize traversal");
    assert.equal(dashStatus.data.filename, "DokiClips/_CON.mp4");

    // Unknown/executable suffix (.exe) is never allowed as final output extension
    const enqueueExeResp = await sendExternal({
      type: "WEB_EXT_ENQUEUE_MEDIA",
      payload: {
        kind: "direct_download",
        platform: "bilibili",
        title: "Exe Guard",
        filename: "../../payload.exe",
        routes: ["https://upos-sz-mirrorcos.bilivideo.com/safe.mp4"],
      },
    });
    assert.equal(enqueueExeResp.ok, true);
    const exeStatus = await sendExternal({
      type: "WEB_EXT_GET_TASK_STATUS",
      taskId: enqueueExeResp.data.taskId,
    });
    assert.equal(exeStatus.ok, true);
    assert.equal(exeStatus.data.filename.endsWith(".exe"), false);
    assert.equal(exeStatus.data.filename.endsWith(".mp4"), true);
    assert.equal(exeStatus.data.filename.includes(".."), false);
    assert.deepEqual(
      Object.keys(dashStatus.data).sort(),
      ["filename", "loadedBytes", "phase", "progress", "speedBytesPerSec", "status", "statusText", "taskId", "totalBytes"],
    );
    assert.equal(
      JSON.stringify(dashStatus).includes("doki_top_secret_token_never_leak"),
      false,
    );
    assert.equal(
      JSON.stringify(dashStatus).includes("bilivideo.com"),
      false,
      "status response must not echo raw CDN URLs",
    );

    // Direct download preserves .m4a extension
    const enqueueAudioResp = await sendExternal({
      type: "WEB_EXT_ENQUEUE_MEDIA",
      payload: {
        kind: "direct_download",
        platform: "bilibili",
        title: "B站原声",
        filename: "B站原声.m4a",
        mimeType: "audio/mp4",
        routes: ["https://upos-sz-mirrorcos.bilivideo.com/audio-only.m4s"],
      },
    });
    assert.equal(enqueueAudioResp.ok, true);
    const audioStatus = await sendExternal({
      type: "WEB_EXT_GET_TASK_STATUS",
      taskId: enqueueAudioResp.data.taskId,
    });
    assert.equal(audioStatus.ok, true);
    assert.equal(audioStatus.data.filename, "DokiClips/B站原声.m4a");

    // SidePanel-created taskId MUST NOT be queryable via WEB_EXT_GET_TASK_STATUS!
    const internalResp = await new Promise((resolveInternal) => {
      bg.handleRuntimeMessage(
        {
          type: "ENQUEUE_DOWNLOADS",
          items: [
            {
              title: "Internal SidePanel Task",
              platform: "bilibili",
              spec: {
                kind: "direct_file",
                apiOrigin: "https://snap.dokitool.com",
                routes: ["https://upos-sz-mirrorcos.bilivideo.com/internal.mp4"],
                filename: "internal.mp4",
              },
            },
          ],
        },
        { id: DOKITOOL_EXTENSION_ID },
        (r) => resolveInternal(r),
      );
    });
    assert.equal(internalResp.ok, true);
    const internalTaskId = internalResp.data.tasks[0].taskId;
    const crossTaskStatus = await sendExternal({
      type: "WEB_EXT_GET_TASK_STATUS",
      taskId: internalTaskId,
    });
    assert.equal(crossTaskStatus.ok, false);
    assert.equal(crossTaskStatus.code, "TASK_NOT_FOUND");
  } finally {
    bg.dispose();
  }

  // 3) Web extensionBridge.ts client behavior (missing runtime, lastError, timeout, connected)
  const prevChrome = globalThis.chrome;
  try {
    delete globalThis.chrome;
    assert.deepEqual(await extensionBridge.pingInstalledExtension({ timeoutMs: 50 }), {
      connected: false,
      version: "",
      extensionId: "",
      capabilities: [],
      useSaveFilePicker: false,
    });

    // lastError path
    globalThis.chrome = {
      runtime: {
        lastError: { message: "Could not establish connection." },
        sendMessage(_id, _msg, cb) { cb(undefined); },
      },
    };
    assert.equal((await extensionBridge.pingInstalledExtension({ timeoutMs: 50 })).connected, false);

    // Timeout path (callback never invoked)
    globalThis.chrome = {
      runtime: {
        sendMessage() {},
      },
    };
    assert.equal((await extensionBridge.pingInstalledExtension({ timeoutMs: 50 })).connected, false);

    // Connected path with exact DOKITOOL_EXTENSION_ID verification
    const sent = [];
    globalThis.chrome = {
      runtime: {
        sendMessage(extId, msg, cb) {
          sent.push({ extId, msg });
          if (msg.type === "WEB_EXT_PING") {
            cb({
              ok: true,
              data: {
                version: "1.2.3",
                extensionId: DOKITOOL_EXTENSION_ID,
                capabilities: ["dash_mux", "direct_download"],
              },
            });
          } else if (msg.type === "WEB_EXT_ENQUEUE_MEDIA") {
            cb({ ok: true, data: { taskId: "web-task-1", status: "queued" } });
          } else if (msg.type === "WEB_EXT_GET_TASK_STATUS") {
            cb({
              ok: true,
              data: {
                taskId: "web-task-1",
                status: "completed",
                phase: "completed",
                progress: 100,
                loadedBytes: 1024,
                totalBytes: 1024,
                speedBytesPerSec: 0,
                filename: "clip.mp4",
              },
            });
          }
        },
      },
    };
    const info = await extensionBridge.pingInstalledExtension({ timeoutMs: 200 });
    assert.deepEqual(info, {
      connected: true,
      version: "1.2.3",
      extensionId: DOKITOOL_EXTENSION_ID,
      capabilities: ["dash_mux", "direct_download"],
      useSaveFilePicker: false,
    });
    assert.equal(extensionBridge.hasExtensionCapability(info, "dash_mux"), true);
    const enq = await extensionBridge.enqueueMediaViaExtension({
      kind: "direct_download",
      platform: "bilibili",
      title: "clip",
      filename: "clip.mp4",
      routes: ["https://upos-sz-mirrorcos.bilivideo.com/clip.mp4"],
    });
    assert.deepEqual(enq, { ok: true, data: { taskId: "web-task-1", status: "queued" } });
    const st = await extensionBridge.getExtensionTaskStatus("web-task-1");
    assert.equal(st.ok, true);
    assert.equal(st.data.status, "completed");
    assert.ok(sent.every((entry) => entry.extId === DOKITOOL_EXTENSION_ID));
  } finally {
    if (prevChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = prevChrome;
  }
});

test("PR-2 Web External Bridge: WEB_EXT_PARSE_YOUTUBE (valid/invalid videoId, zero-secret anonymous fetch, LOGIN_REQUIRED), youtube_mux/youtube_direct strict *.googlevideo.com whitelist, and WEB_EXT_CANCEL_TASK isolation", async () => {
  const prodManifest = {
    version: "4.2.0",
    externally_connectable: { matches: PROD_EXTERNALLY_CONNECTABLE_MATCHES },
  };
  const devManifest = {
    version: "4.2.0",
    externally_connectable: { matches: DEV_LOOPBACK_EXTERNALLY_CONNECTABLE_MATCHES },
  };

  let activeManifest = prodManifest;
  let nextPlayerStatus = "OK";
  const observedFetches = [];
  const offscreenMessages = [];
  const cancelledDownloadIds = [];
  let dnrSyncCount = 0;

  const mockFetch = async (url, init = {}) => {
    const reqUrl = String(url);
    const headers = Object.fromEntries(
      Object.entries(init.headers || {}).map(([k, v]) => [k.toLowerCase(), String(v)]),
    );
    observedFetches.push({
      url: reqUrl,
      method: init.method || "GET",
      credentials: init.credentials,
      headers,
      body: init.body,
    });

    if (reqUrl.includes("/api/youtube/context")) {
      return new Response(
        JSON.stringify({
          schema_version: "1.0",
          code: "OK",
          data: {
            player_id: "player-anon-1",
            signature_timestamp: 20100,
            client: {
              clientName: "TVHTML5",
              clientVersion: "7.20260101.00.00",
              hl: "en",
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    if (reqUrl.includes("/api/youtube/finalize")) {
      const parsedBody = JSON.parse(String(init.body || "{}"));
      return new Response(
        JSON.stringify({
          schema_version: "1.0",
          code: "OK",
          data: {
            platform: "youtube",
            content_id: parsedBody.video_id,
            source_url: `https://www.youtube.com/watch?v=${parsedBody.video_id}`,
            title: parsedBody.title || "Web Bridge 4K Demo",
            items: [
              {
                id: "item-1",
                type: "video",
                state: "ready",
                variants: [
                  {
                    id: "v-2160",
                    state: "ready",
                    label: "2160p60",
                    metadata: { width: 3840, height: 2160, has_audio: false, container: "mp4" },
                    delivery: {
                      kind: "file",
                      sources: [
                        {
                          id: "src-v",
                          url: "https://rr1---sn-test.googlevideo.com/videoplayback?itag=313",
                          access: "direct",
                        },
                      ],
                    },
                  },
                ],
                default: {
                  variant_id: "v-2160",
                  url: "https://rr1---sn-test.googlevideo.com/videoplayback?itag=313",
                  access: "direct",
                },
              },
            ],
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    return new Response(JSON.stringify({ code: "NOT_FOUND" }), { status: 404 });
  };

  const extStore = storage.createExtensionStorage({
    local: storage.createMemoryStorageArea(),
    session: storage.createMemoryStorageArea(),
  });
  await extStore.updateSettings({
    bearerToken: "doki_owner_secret_MUST_NEVER_BE_SENT_ON_WEB_BRIDGE",
    apiBaseUrl: "https://custom-owner-backend.example.com",
    subfolderPrefix: "DokiClips",
  });

  const externalListeners = [];
  const mockChrome = {
    runtime: {
      id: DOKITOOL_EXTENSION_ID,
      getManifest: () => activeManifest,
      onMessage: { addListener() {}, removeListener() {} },
      onMessageExternal: {
        addListener(fn) { externalListeners.push(fn); },
        removeListener(fn) {
          const i = externalListeners.indexOf(fn);
          if (i >= 0) externalListeners.splice(i, 1);
        },
      },
      onConnect: { addListener() {} },
      onInstalled: { addListener() {} },
      onStartup: { addListener() {} },
      sendMessage: async (msg) => {
        offscreenMessages.push(msg);
        if (msg?.type === "OFFSCREEN_YOUTUBE_PLAYER") {
          return {
            ok: true,
            data: {
              player: {
                playabilityStatus: { status: nextPlayerStatus },
                videoDetails: {
                  title: "Zero Secret 4K60 Video",
                  author: "TestChannel",
                  lengthSeconds: 180,
                },
                streamingData: { formats: [], adaptiveFormats: [] },
              },
            },
          };
        }
        return { ok: true, data: { accepted: true, cancelled: true } };
      },
      getContexts: async () => [{ contextType: "OFFSCREEN_DOCUMENT" }],
    },
    declarativeNetRequest: {
      updateDynamicRules: async () => { dnrSyncCount += 1; },
      getDynamicRules: async () => [],
    },
    downloads: {
      download: async () => 101,
      cancel: async (id) => { cancelledDownloadIds.push(id); },
      onChanged: { addListener() {}, removeListener() {} },
      onDeterminingFilename: { addListener() {}, removeListener() {} },
    },
    offscreen: {
      createDocument: async () => {},
      closeDocument: async () => {},
    },
    action: {
      setBadgeText: async () => {},
      setBadgeBackgroundColor: async () => {},
      setTitle: async () => {},
    },
  };

  const bg = backgroundMod.createBackgroundController({
    chrome: mockChrome,
    storage: extStore,
    fetchImpl: mockFetch,
  });

  const sendExternal = (
    msg,
    sender = { origin: "https://snap.dokitool.com", url: "https://snap.dokitool.com/" },
  ) =>
    new Promise((resolveResp) => {
      externalListeners[0](msg, sender, (resp) => resolveResp(resp));
    });

  try {
    // 1) Invalid YouTube videoId rejected before any network or offscreen call
    for (const badVideoId of ["", "short", "waytoolongvideoid123", "bad/char!11", 12345678901]) {
      const resp = await sendExternal({
        type: "WEB_EXT_PARSE_YOUTUBE",
        videoId: badVideoId,
      });
      assert.equal(resp.ok, false);
      assert.equal(resp.code, "INVALID_PAYLOAD");
    }
    assert.equal(observedFetches.length, 0);
    assert.equal(offscreenMessages.length, 0);

    // 2) Valid videoId runs DNR sync + anonymous /api/youtube/context & /api/youtube/finalize on PROD_API_ORIGIN
    const parseResp = await sendExternal({
      type: "WEB_EXT_PARSE_YOUTUBE",
      videoId: "dQw4w9WgXcQ",
      locale: "zh-CN",
    });
    assert.equal(parseResp.ok, true);
    assert.ok(dnrSyncCount >= 1, "must sync dynamic DNR rules before YouTube player request");
    assert.equal(observedFetches.length, 2);
    assert.ok(
      observedFetches[0].url.startsWith("https://snap.dokitool.com/api/youtube/context"),
      "prod web bridge must ignore custom owner apiBaseUrl and use PROD_API_ORIGIN",
    );
    assert.ok(
      observedFetches[1].url.startsWith("https://snap.dokitool.com/api/youtube/finalize"),
    );
    for (const req of observedFetches) {
      assert.equal(req.credentials, "omit");
      assert.equal(
        req.headers.authorization,
        undefined,
        "WEB_EXT_PARSE_YOUTUBE must NEVER send owner's bearerToken",
      );
      assert.equal(
        JSON.stringify(req).includes("doki_owner_secret_MUST_NEVER_BE_SENT_ON_WEB_BRIDGE"),
        false,
      );
    }
    assert.equal(parseResp.data.media.content_id, "dQw4w9WgXcQ");
    assert.equal(parseResp.data.media.extra?.youtube_helper?.status, "ready");
    assert.equal(parseResp.data.media.extra?.youtube_helper?.provider, "extension");
    assert.equal(parseResp.data.media.extra?.youtube_helper?.version, "4.2.0");
    assert.equal(parseResp.data.media.extra?.youtube_helper?.extensionVersion, "4.2.0");
    assert.equal(
      JSON.stringify(parseResp).includes("doki_owner_secret_MUST_NEVER_BE_SENT_ON_WEB_BRIDGE"),
      false,
    );

    // 3) LOGIN_REQUIRED returns structured code and skips /api/youtube/finalize
    observedFetches.length = 0;
    nextPlayerStatus = "LOGIN_REQUIRED";
    const loginReqResp = await sendExternal({
      type: "WEB_EXT_PARSE_YOUTUBE",
      videoId: "I9JvDaciaFk",
    });
    assert.equal(loginReqResp.ok, false);
    assert.equal(loginReqResp.code, "LOGIN_REQUIRED");
    assert.equal(observedFetches.length, 1, "must not call /api/youtube/finalize after LOGIN_REQUIRED");
    nextPlayerStatus = "OK";

    // 4) Strict *.googlevideo.com whitelist on youtube_mux & youtube_direct (rejects bilivideo, apex, http, evil, loopback on prod)
    for (const badUrl of [
      "https://upos-sz-mirrorcos.bilivideo.com/video.m4s",
      "https://googlevideo.com/videoplayback",
      "http://rr1---sn-test.googlevideo.com/videoplayback",
      "https://rr1---sn-test.googlevideo.com.evil.test/videoplayback",
      "https://evil.example.com/video.mp4",
      "http://127.0.0.1:5173/mock.mp4",
    ]) {
      const badMux = await sendExternal({
        type: "WEB_EXT_ENQUEUE_MEDIA",
        payload: {
          kind: "youtube_mux",
          platform: "youtube",
          title: "Bad YT Mux",
          filename: "video.mp4",
          youtubeMux: {
            videoUrl: badUrl,
            audioUrl: "https://rr2---sn-test.googlevideo.com/audio",
            outputContainer: "mp4",
          },
        },
      });
      assert.equal(badMux.ok, false, `youtube_mux must reject videoUrl=${badUrl}`);
      assert.equal(badMux.code, "UNWHITELISTED_CDN");

      const badMuxAudio = await sendExternal({
        type: "WEB_EXT_ENQUEUE_MEDIA",
        payload: {
          kind: "youtube_mux",
          platform: "youtube",
          title: "Bad YT Mux Audio",
          filename: "video.mp4",
          youtubeMux: {
            videoUrl: "https://rr1---sn-test.googlevideo.com/video",
            audioUrl: badUrl,
            outputContainer: "mp4",
          },
        },
      });
      assert.equal(badMuxAudio.ok, false, `youtube_mux must reject audioUrl=${badUrl}`);
      assert.equal(badMuxAudio.code, "UNWHITELISTED_CDN");

      const badDirect = await sendExternal({
        type: "WEB_EXT_ENQUEUE_MEDIA",
        payload: {
          kind: "youtube_direct",
          platform: "youtube",
          title: "Bad YT Direct",
          filename: "video.mp4",
          url: badUrl,
        },
      });
      assert.equal(badDirect.ok, false, `youtube_direct must reject url=${badUrl}`);
      assert.equal(badDirect.code, "UNWHITELISTED_CDN");
    }

    // Invalid youtube_mux container rejected with INVALID_PAYLOAD
    const badContainer = await sendExternal({
      type: "WEB_EXT_ENQUEUE_MEDIA",
      payload: {
        kind: "youtube_mux",
        platform: "youtube",
        filename: "clip.mkv",
        youtubeMux: {
          videoUrl: "https://rr1---sn-test.googlevideo.com/video",
          audioUrl: "https://rr2---sn-test.googlevideo.com/audio",
          outputContainer: "mkv",
        },
      },
    });
    assert.equal(badContainer.ok, false);
    assert.equal(badContainer.code, "INVALID_PAYLOAD");

    // 5) Valid youtube_mux (webm) & youtube_direct (m4a / forced safe ext) succeed and sanitize filenames
    const ytMuxResp = await sendExternal({
      type: "WEB_EXT_ENQUEUE_MEDIA",
      payload: {
        kind: "youtube_mux",
        platform: "youtube",
        title: "4K60 WebM Test",
        filename: "../../CON.mp4",
        youtubeMux: {
          videoUrl: "https://rr1---sn-test.googlevideo.com/video?itag=315",
          audioUrl: "https://rr2---sn-test.googlevideo.com/audio?itag=251",
          videoSize: 50_000_000,
          audioSize: 4_000_000,
          outputContainer: "webm",
        },
      },
    });
    assert.equal(ytMuxResp.ok, true);
    const ytMuxStatus = await sendExternal({
      type: "WEB_EXT_GET_TASK_STATUS",
      taskId: ytMuxResp.data.taskId,
    });
    assert.equal(ytMuxStatus.ok, true);
    assert.equal(ytMuxStatus.data.filename, "DokiClips/_CON.webm");

    const ytDirectM4a = await sendExternal({
      type: "WEB_EXT_ENQUEUE_MEDIA",
      payload: {
        kind: "youtube_direct",
        platform: "youtube",
        title: "YT Audio",
        filename: "原声.m4a",
        url: "https://rr3---sn-test.googlevideo.com/audio?itag=140",
        mimeType: "audio/mp4",
      },
    });
    assert.equal(ytDirectM4a.ok, true);
    const ytDirectM4aStatus = await sendExternal({
      type: "WEB_EXT_GET_TASK_STATUS",
      taskId: ytDirectM4a.data.taskId,
    });
    assert.equal(ytDirectM4aStatus.data.filename, "DokiClips/原声.m4a");

    const ytDirectBadExt = await sendExternal({
      type: "WEB_EXT_ENQUEUE_MEDIA",
      payload: {
        kind: "youtube_direct",
        platform: "youtube",
        title: "YT Ext Guard",
        filename: "image.jpg",
        url: "https://rr3---sn-test.googlevideo.com/video?itag=18",
      },
    });
    assert.equal(ytDirectBadExt.ok, true);
    const ytDirectBadExtStatus = await sendExternal({
      type: "WEB_EXT_GET_TASK_STATUS",
      taskId: ytDirectBadExt.data.taskId,
    });
    assert.equal(
      ytDirectBadExtStatus.data.filename.endsWith(".mp4"),
      true,
      "youtube_direct must only permit .mp4/.m4a/.webm",
    );

    // 6) Dev loopback sender allows ONLY exact sender origin over http: while still rejecting mismatched port or bilivideo
    activeManifest = devManifest;
    const loopbackSender = {
      origin: "http://127.0.0.1:5173",
      url: "http://127.0.0.1:5173/",
    };
    const devLoopbackOk = await sendExternal(
      {
        type: "WEB_EXT_ENQUEUE_MEDIA",
        payload: {
          kind: "youtube_direct",
          platform: "youtube",
          filename: "loopback.webm",
          url: "http://127.0.0.1:5173/mock-yt.webm",
        },
      },
      loopbackSender,
    );
    assert.equal(devLoopbackOk.ok, true);
    const devWrongPort = await sendExternal(
      {
        type: "WEB_EXT_ENQUEUE_MEDIA",
        payload: {
          kind: "youtube_direct",
          platform: "youtube",
          filename: "loopback.mp4",
          url: "http://127.0.0.1:9999/mock-yt.mp4",
        },
      },
      loopbackSender,
    );
    assert.equal(devWrongPort.ok, false);
    assert.equal(devWrongPort.code, "UNWHITELISTED_CDN");
    activeManifest = prodManifest;

    // 7) WEB_EXT_CANCEL_TASK cancels web-bridge tasks and rejects internal SidePanel tasks with TASK_NOT_FOUND
    const cancelWebResp = await sendExternal({
      type: "WEB_EXT_CANCEL_TASK",
      taskId: ytMuxResp.data.taskId,
    });
    assert.deepEqual(cancelWebResp, {
      ok: true,
      data: { taskId: ytMuxResp.data.taskId, cancelled: true },
    });
    const afterCancelStatus = await sendExternal({
      type: "WEB_EXT_GET_TASK_STATUS",
      taskId: ytMuxResp.data.taskId,
    });
    assert.equal(afterCancelStatus.ok, true);
    assert.equal(afterCancelStatus.data.status, "cancelled");
    assert.equal(afterCancelStatus.data.phase, "cancelled");
    assert.ok(
      offscreenMessages.some(
        (m) => m?.type === "OFFSCREEN_CANCEL_TASK" && m.taskId === ytMuxResp.data.taskId,
      ),
    );

    const internalResp = await new Promise((resolveInternal) => {
      bg.handleRuntimeMessage(
        {
          type: "ENQUEUE_DOWNLOADS",
          items: [
            {
              title: "Internal Only Task",
              platform: "bilibili",
              spec: {
                kind: "direct_file",
                apiOrigin: "https://snap.dokitool.com",
                routes: ["https://upos-sz-mirrorcos.bilivideo.com/internal-only.mp4"],
                filename: "internal-only.mp4",
              },
            },
          ],
        },
        { id: DOKITOOL_EXTENSION_ID },
        (r) => resolveInternal(r),
      );
    });
    assert.equal(internalResp.ok, true);
    const internalTaskId = internalResp.data.tasks[0].taskId;
    const crossCancel = await sendExternal({
      type: "WEB_EXT_CANCEL_TASK",
      taskId: internalTaskId,
    });
    assert.equal(crossCancel.ok, false);
    assert.equal(crossCancel.code, "TASK_NOT_FOUND");
    const snap = await bg.getSnapshot();
    const internalTask = snap.tasks.find((t) => t.taskId === internalTaskId);
    assert.ok(internalTask);
    assert.notEqual(
      internalTask.status,
      "cancelled",
      "rejected WEB_EXT_CANCEL_TASK must never mutate internal SidePanel task",
    );
  } finally {
    bg.dispose();
  }
});

test("PR-2 Authoritative onDeterminingFilename gatekeeper resists Chromium UUID overwrite, ignores unrelated/other-extension downloads, and cleans up across lifecycle", async () => {
  const extStore = storage.createExtensionStorage({
    local: storage.createMemoryStorageArea(),
    session: storage.createMemoryStorageArea(),
  });
  const determiningListeners = [];
  const changedListeners = [];
  let nextDlId = 500;
  let fireSyncDuringDownload = true;
  let failNextDownload = false;
  const syncSuggestions = [];

  const mockChrome = {
    runtime: {
      id: DOKITOOL_EXTENSION_ID,
      getManifest: () => ({ version: "4.2.0" }),
      onMessage: { addListener() {}, removeListener() {} },
      onMessageExternal: { addListener() {}, removeListener() {} },
      onConnect: { addListener() {} },
      onInstalled: { addListener() {} },
      onStartup: { addListener() {} },
      sendMessage: async () => ({ ok: true, data: { released: true } }),
      getContexts: async () => [{ contextType: "OFFSCREEN_DOCUMENT" }],
    },
    declarativeNetRequest: {
      updateDynamicRules: async () => {},
      getDynamicRules: async () => [],
    },
    downloads: {
      download: async (opts) => {
        if (failNextDownload) {
          failNextDownload = false;
          throw new Error("Simulated downloads.download failure");
        }
        const dlId = ++nextDlId;
        if (fireSyncDuringDownload) {
          // Simulate Chromium firing onDeterminingFilename synchronously BEFORE download() resolves with a UUID filename
          const ret = determiningListeners[0](
            {
              id: dlId,
              url: opts.url,
              finalUrl: opts.url,
              filename: "f47ac10b-58cc-4372-a567-0e02b2c3d479.txt",
              byExtensionId: DOKITOOL_EXTENSION_ID,
            },
            (suggestion) => syncSuggestions.push(suggestion),
          );
          assert.equal(ret, undefined, "onDeterminingFilename must call suggest synchronously and not return true");
        }
        return dlId;
      },
      cancel: async () => {},
      onChanged: {
        addListener(fn) { changedListeners.push(fn); },
        removeListener(fn) {
          const idx = changedListeners.indexOf(fn);
          if (idx >= 0) changedListeners.splice(idx, 1);
        },
      },
      onDeterminingFilename: {
        addListener(fn) { determiningListeners.push(fn); },
        removeListener(fn) {
          const idx = determiningListeners.indexOf(fn);
          if (idx >= 0) determiningListeners.splice(idx, 1);
        },
      },
    },
    offscreen: {
      createDocument: async () => {},
      closeDocument: async () => {},
    },
    action: {
      setBadgeText: async () => {},
      setBadgeBackgroundColor: async () => {},
      setTitle: async () => {},
    },
  };

  const bg = backgroundMod.createBackgroundController({
    chrome: mockChrome,
    storage: extStore,
  });

  const sendInternal = (msg) =>
    new Promise((resolveResp) => {
      bg.handleRuntimeMessage(msg, { id: DOKITOOL_EXTENSION_ID }, (resp) =>
        resolveResp(resp),
      );
    });

  try {
    assert.equal(determiningListeners.length, 1, "must register onDeterminingFilename listener");

    // 1) Blob handoff: synchronous onDeterminingFilename with UUID filename overridden with authoritative relative path
    const blobUrl1 = `blob:chrome-extension://${DOKITOOL_EXTENSION_ID}/11111111-2222-3333-4444-555555555555`;
    const handoff1 = await sendInternal({
      type: "HANDOFF_BLOB_DOWNLOAD",
      taskId: "task-blob-1",
      blobUrl: blobUrl1,
      filename: "DokiClips/我的4K演示视频.mp4",
      mimeType: "video/mp4",
      sizeBytes: 12345,
    });
    assert.equal(handoff1.ok, true);
    const dlId1 = handoff1.data.chromeDownloadId;
    assert.deepEqual(syncSuggestions, [
      { filename: "DokiClips/我的4K演示视频.mp4", conflictAction: "uniquify" },
    ]);

    // 2) Unrelated normal browser download & other-extension download MUST be ignored (suggest not called)
    const unrelatedSuggestions = [];
    determiningListeners[0](
      {
        id: 9999,
        url: "https://example.org/report.pdf",
        finalUrl: "https://example.org/report.pdf",
        filename: "report.pdf",
      },
      (s) => unrelatedSuggestions.push(s),
    );
    determiningListeners[0](
      {
        id: 9998,
        url: blobUrl1,
        finalUrl: blobUrl1,
        filename: "other.mp4",
        byExtensionId: "differentextensionid000000000000",
      },
      (s) => unrelatedSuggestions.push(s),
    );
    assert.equal(unrelatedSuggestions.length, 0);

    // 3) Terminal onChanged cleans up both authoritative maps
    changedListeners[0]({
      id: dlId1,
      state: { previous: "in_progress", current: "complete" },
    });
    await bg.waitForIdle();
    const afterCompleteSuggestions = [];
    determiningListeners[0](
      {
        id: dlId1,
        url: blobUrl1,
        filename: "uuid-after-complete.txt",
        byExtensionId: DOKITOOL_EXTENSION_ID,
      },
      (s) => afterCompleteSuggestions.push(s),
    );
    assert.equal(afterCompleteSuggestions.length, 0, "maps must be cleaned after terminal onChanged");

    // 4) Failed downloads.download cleans up authoritativeFilenamesByUrl immediately
    failNextDownload = true;
    const blobUrlFail = `blob:chrome-extension://${DOKITOOL_EXTENSION_ID}/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee`;
    const failedHandoff = await sendInternal({
      type: "HANDOFF_BLOB_DOWNLOAD",
      taskId: "task-blob-fail",
      blobUrl: blobUrlFail,
      filename: "DokiClips/fail.mp4",
    });
    assert.equal(failedHandoff.ok, false);
    const afterErrorSuggestions = [];
    determiningListeners[0](
      {
        id: 7777,
        url: blobUrlFail,
        filename: "uuid.txt",
        byExtensionId: DOKITOOL_EXTENSION_ID,
      },
      (s) => afterErrorSuggestions.push(s),
    );
    assert.equal(afterErrorSuggestions.length, 0, "maps must be cleaned on downloads.download error");

    // 5) Native fallback download + asynchronous onDeterminingFilename (by downloadId) + cancel cleanup
    fireSyncDuringDownload = false;
    const nativeEnqueue = await sendInternal({
      type: "ENQUEUE_DOWNLOADS",
      items: [
        {
          title: "Long-tail Native MP4",
          platform: "generic",
          spec: {
            kind: "direct_file",
            apiOrigin: "https://snap.dokitool.com",
            routes: ["https://cdn.vimeo.example/video/1080p.mp4"],
            filename: "DokiClips/Vimeo 演示.mp4",
          },
        },
      ],
    });
    assert.equal(nativeEnqueue.ok, true);
    const nativeTaskId = nativeEnqueue.data.taskIds[0];
    // Allow dispatch microtasks to register native download
    await new Promise((r) => setTimeout(r, 20));
    const snapBeforeCancel = await bg.getSnapshot();
    const nativeTask = snapBeforeCancel.tasks.find((t) => t.taskId === nativeTaskId);
    assert.ok(nativeTask && typeof nativeTask.chromeDownloadId === "number");
    const nativeDlId = nativeTask.chromeDownloadId;

    const asyncNativeSuggestions = [];
    determiningListeners[0](
      {
        id: nativeDlId,
        url: "https://redirected-edge.vimeo.example/random-uuid",
        finalUrl: "https://cdn.vimeo.example/video/1080p.mp4",
        filename: "random-uuid.bin",
        byExtensionId: DOKITOOL_EXTENSION_ID,
      },
      (s) => asyncNativeSuggestions.push(s),
    );
    assert.deepEqual(asyncNativeSuggestions, [
      { filename: "DokiClips/Vimeo 演示.mp4", conflictAction: "uniquify" },
    ]);

    // Cancelling the task must clean up both authoritative maps
    const cancelRes = await sendInternal({ type: "CANCEL_TASK", taskId: nativeTaskId });
    assert.equal(cancelRes.ok, true);
    const afterCancelSuggestions = [];
    determiningListeners[0](
      {
        id: nativeDlId,
        url: "https://cdn.vimeo.example/video/1080p.mp4",
        filename: "late.bin",
        byExtensionId: DOKITOOL_EXTENSION_ID,
      },
      (s) => afterCancelSuggestions.push(s),
    );
    assert.equal(afterCancelSuggestions.length, 0, "maps must be cleaned on cancel");
  } finally {
    bg.dispose();
  }

  assert.equal(
    determiningListeners.length,
    0,
    "dispose() must remove onDeterminingFilename listener",
  );
  assert.equal(
    changedListeners.length,
    0,
    "dispose() must remove onChanged listener",
  );
});

test("PR-2 Blob URL File wrapper: extensionDownload.ts and youtubeExtensionBridge.ts wrap OPFS blobs in File with leaf filename and authoritative MIME", async () => {
  assert.equal(typeof File, "function", "Node 20+ test runtime must expose global File");

  // 1) extensionDownload.ts (direct_file -> OPFS -> handoffSinkAndWaitRelease)
  const extBlobsCreated = [];
  const extUrlApi = {
    createObjectURL(blob) {
      extBlobsCreated.push(blob);
      return `blob:ext-test/${extBlobsCreated.length}`;
    },
    revokeObjectURL() {},
  };
  const payloadBytes = new Uint8Array([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70]);
  const executor = extensionDownloadMod.createOffscreenDownloadExecutor({
    fetchImpl: async () =>
      new Response(payloadBytes, {
        status: 200,
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Length": String(payloadBytes.byteLength),
        },
      }),
    urlApi: extUrlApi,
    opfsStorage: null,
    handoffBlobDownload: async (msg) => {
      queueMicrotask(() =>
        executor.releaseBlob({
          taskId: msg.taskId,
          blobUrl: msg.blobUrl,
          opfsTempName: msg.opfsTempName,
        }),
      );
      return { chromeDownloadId: 1 };
    },
    onProgress() {},
    onError(err) {
      throw new Error(`unexpected task error: ${err.error}`);
    },
  });

  executor.startTask("t-file-ext", {
    kind: "direct_file",
    apiOrigin: "https://snap.dokitool.com",
    routes: ["https://upos-sz-mirrorcos.bilivideo.com/sample.mp4"],
    filename: "DokiClips/子目录/测试视频.mp4",
    mimeType: "video/mp4",
  });
  await executor.waitForIdle();
  executor.dispose();

  assert.equal(extBlobsCreated.length, 1);
  assert.ok(extBlobsCreated[0] instanceof File, "extensionDownload must wrap Blob in File");
  assert.equal(extBlobsCreated[0].name, "测试视频.mp4");
  assert.equal(extBlobsCreated[0].type, "video/mp4");

  // 2) youtubeExtensionBridge.ts (downloadDirect -> handoffAndAwaitAuthoritativeRelease)
  const ytBlobsCreated = [];
  const ytUrlApi = {
    createObjectURL(blob) {
      ytBlobsCreated.push(blob);
      return `blob:yt-test/${ytBlobsCreated.length}`;
    },
    revokeObjectURL() {},
  };
  const ytBytes = new Uint8Array(1024).fill(0x1a);
  const ytBridge = youtubeExtensionBridgeMod.createYouTubeExtensionBridge({
    fetchImpl: async (_url, init) => {
      const rangeHeader = init?.headers?.Range || init?.headers?.range;
      if (rangeHeader) {
        return new Response(ytBytes, {
          status: 206,
          headers: {
            "Content-Type": "video/webm",
            "Content-Length": String(ytBytes.byteLength),
            "Content-Range": `bytes 0-${ytBytes.byteLength - 1}/${ytBytes.byteLength}`,
          },
        });
      }
      return new Response(ytBytes, {
        status: 200,
        headers: {
          "Content-Type": "video/webm",
          "Content-Length": String(ytBytes.byteLength),
        },
      });
    },
    urlApi: ytUrlApi,
    opfsStorage: null,
    handoffBlobDownload: async (msg) => {
      queueMicrotask(() =>
        ytBridge.releaseBlob({ taskId: msg.taskId, blobUrl: msg.blobUrl }),
      );
      return { chromeDownloadId: 2 };
    },
  });

  await ytBridge.downloadDirect({
    taskId: "t-file-yt",
    url: "https://rr1---sn-test.googlevideo.com/videoplayback?itag=248",
    filename: "DokiClips/YouTube 4K/Demo Clip.webm",
    sizeBytes: ytBytes.byteLength,
  });
  ytBridge.dispose();

  assert.equal(ytBlobsCreated.length, 1);
  assert.ok(ytBlobsCreated[0] instanceof File, "youtubeExtensionBridge must wrap Blob in File");
  assert.equal(ytBlobsCreated[0].name, "Demo Clip.webm");
  assert.equal(ytBlobsCreated[0].type, "video/webm");
});

test("Issue #48 [P1-1] Spec B.3: filenameAudit detects UUID/stem tamper, downloadCoordinator + webExternalBridge emit sanitized filenameWarning, and saveFilePicker streams directly", async () => {
  const [filenameAudit, saveFilePicker] = await Promise.all([
    bundleTsModule("../src/extension/bg/filenameAudit.ts"),
    bundleTsModule("../src/downloads/saveFilePicker.ts"),
  ]);

  // 1) Pure filename tamper audit cases
  assert.equal(
    filenameAudit.detectFilenameTampering("DokiClips/测试作品_1080p.mp4", "/Users/u/Downloads/DokiClips/测试作品_1080p.mp4").tampered,
    false,
  );
  assert.equal(
    filenameAudit.detectFilenameTampering("测试作品_1080p.mp4", "/Users/u/Downloads/测试作品_1080p (1).mp4").tampered,
    false,
    "Chrome (1) uniquify suffix must be tolerated",
  );
  const uuidHit = filenameAudit.detectFilenameTampering(
    "DokiClips/测试作品_1080p.mp4",
    "/Users/u/Downloads/550e8400-e29b-41d4-a716-446655440000.mp4",
  );
  assert.equal(uuidHit.tampered, true);
  assert.equal(uuidHit.reason, "uuid_overwrite");
  assert.match(uuidHit.warning || "", /其他下载类扩展改写了保存文件名/);

  const stemHit = filenameAudit.detectFilenameTampering(
    "测试作品_1080p.mp4",
    "C:\\Users\\alice\\Downloads\\videoplayback.mp4",
  );
  assert.equal(stemHit.tampered, true);
  assert.equal(stemHit.reason, "stem_mismatch");

  // 2) End-to-end downloadCoordinator + webExternalBridge filenameWarning propagation (sanitized, zero path/token leaks)
  const changedListeners = [];
  const externalListeners = [];
  let nextDlId = 700;
  const mockChrome = {
    runtime: {
      id: DOKITOOL_EXTENSION_ID,
      getManifest: () => ({
        version: "4.4.1",
        host_permissions: ["https://snap.dokitool.com/*"],
        optional_host_permissions: ["http://127.0.0.1/*", "http://localhost/*"],
      }),
      onMessage: { addListener() {}, removeListener() {} },
      onMessageExternal: {
        addListener(fn) { externalListeners.push(fn); },
        removeListener(fn) {
          const i = externalListeners.indexOf(fn);
          if (i >= 0) externalListeners.splice(i, 1);
        },
      },
      onConnect: { addListener() {}, removeListener() {} },
      async getContexts() { return [{ contextType: "OFFSCREEN_DOCUMENT" }]; },
      async sendMessage() { return { ok: true }; },
    },
    downloads: {
      async download() { return ++nextDlId; },
      async search({ id }) {
        return [{ id, filename: "/Users/secret-home/Downloads/550e8400-e29b-41d4-a716-446655440000.mp4" }];
      },
      async cancel() {},
      onChanged: {
        addListener(fn) { changedListeners.push(fn); },
        removeListener(fn) {
          const i = changedListeners.indexOf(fn);
          if (i >= 0) changedListeners.splice(i, 1);
        },
      },
      onDeterminingFilename: { addListener() {}, removeListener() {} },
    },
    action: { setBadgeText() {}, setBadgeBackgroundColor() {} },
    declarativeNetRequest: { updateDynamicRules: async () => {}, getDynamicRules: async () => [] },
    contextMenus: { create() {}, removeAll(cb) { cb?.(); }, onClicked: { addListener() {}, removeListener() {} } },
    commands: { onCommand: { addListener() {}, removeListener() {} } },
    tabs: { onActivated: { addListener() {}, removeListener() {} }, onUpdated: { addListener() {}, removeListener() {} }, query: async () => [] },
    offscreen: { createDocument: async () => {}, closeDocument: async () => {} },
    sidePanel: { setPanelBehavior: async () => {}, open: async () => {} },
  };

  const extStorage = storage.createExtensionStorage({
    local: storage.createMemoryStorageArea(),
    session: storage.createMemoryStorageArea(),
  });
  await extStorage.updateSettings({ bearerToken: "secret_token_must_not_leak" });
  const bg = backgroundMod.createBackgroundController({
    chrome: mockChrome,
    storage: extStorage,
    fetchImpl: async () => new Response("{}", { status: 200 }),
  });
  await bg.init();

  const sendExternal = (msg) =>
    new Promise((resolveResp) => {
      externalListeners[0](msg, { origin: "https://snap.dokitool.com" }, resolveResp);
    });

  try {
    const enq = await sendExternal({
      type: "WEB_EXT_ENQUEUE_MEDIA",
      payload: {
        kind: "direct_download",
        platform: "bilibili",
        title: "防篡改审计测试",
        filename: "防篡改审计测试_1080p.mp4",
        routes: ["https://upos-sz-mirrorcos.bilivideo.com/audit.mp4"],
      },
    });
    assert.equal(enq.ok, true);
    const taskId = enq.data.taskId;

    // Trigger offscreen handoff -> chrome.downloads.download -> onChanged complete (with UUID rewrite in downloads.search)
    const handoffResp = await new Promise((resolveHandoff) => {
      bg.handleRuntimeMessage(
        {
          type: "HANDOFF_BLOB_DOWNLOAD",
          taskId,
          blobUrl: "blob:chrome-extension://test/audit-uuid",
          filename: "防篡改审计测试_1080p.mp4",
        },
        { id: DOKITOOL_EXTENSION_ID },
        resolveHandoff,
      );
    });
    assert.equal(handoffResp.ok, true);
    const dlId = handoffResp.data.chromeDownloadId;

    for (const fn of changedListeners) {
      fn({ id: dlId, state: { current: "complete" } });
    }
    await new Promise((r) => setTimeout(r, 20));

    const statusResp = await sendExternal({ type: "WEB_EXT_GET_TASK_STATUS", taskId });
    assert.equal(statusResp.ok, true);
    assert.equal(statusResp.data.status, "completed");
    assert.match(statusResp.data.filenameWarning || "", /其他下载类扩展改写了保存文件名/);
    assert.equal(JSON.stringify(statusResp).includes("secret-home"), false, "must never leak local filesystem path");
    assert.equal(JSON.stringify(statusResp).includes("secret_token_must_not_leak"), false);
  } finally {
    bg.dispose();
  }

  // 3) saveFilePicker helper: promptSaveFileHandle + streamRoutesToFileHandle
  const prevPicker = globalThis.showSaveFilePicker;
  try {
    delete globalThis.showSaveFilePicker;
    assert.equal(saveFilePicker.isSaveFilePickerSupported(), false);
    assert.deepEqual(await saveFilePicker.promptSaveFileHandle("demo.mp4", "video/mp4"), {
      status: "unsupported",
    });

    const writtenChunks = [];
    let closed = false;
    let pickerOpts = null;
    globalThis.showSaveFilePicker = async (opts) => {
      pickerOpts = opts;
      return {
        name: opts.suggestedName,
        async createWritable() {
          return {
            async write(data) { writtenChunks.push(new Uint8Array(data)); },
            async close() { closed = true; },
            async abort() {},
          };
        },
      };
    };
    assert.equal(saveFilePicker.isSaveFilePickerSupported(), true);
    const picked = await saveFilePicker.promptSaveFileHandle("DokiTool/Sub/演示_1080p.mp4", "video/mp4");
    assert.equal(picked.status, "granted");
    assert.equal(pickerOpts.suggestedName, "演示_1080p.mp4");

    const fetchInits = [];
    const streamed = await saveFilePicker.streamRoutesToFileHandle({
      handle: picked.handle,
      routes: ["https://cdn1.example/fail.mp4", "https://cdn2.example/ok.mp4"],
      fetchImpl: async (url, init) => {
        fetchInits.push({ url, credentials: init.credentials, referrerPolicy: init.referrerPolicy });
        if (url.includes("fail")) return new Response("err", { status: 502 });
        return new Response(new Uint8Array([1, 2, 3, 4, 5]), {
          status: 200,
          headers: { "content-length": "5" },
        });
      },
    });
    assert.equal(streamed.loaded, 5);
    assert.equal(closed, true);
    assert.deepEqual(Array.from(writtenChunks[0]), [1, 2, 3, 4, 5]);
    assert.equal(fetchInits[1].credentials, "omit");
    assert.equal(fetchInits[1].referrerPolicy, "no-referrer");

    // User cancellation maps to { status: "cancelled" }
    globalThis.showSaveFilePicker = async () => {
      throw new DOMException("The user aborted a request.", "AbortError");
    };
    assert.deepEqual(await saveFilePicker.promptSaveFileHandle("demo.mp4"), { status: "cancelled" });
  } finally {
    if (prevPicker === undefined) delete globalThis.showSaveFilePicker;
    else globalThis.showSaveFilePicker = prevPicker;
  }
});

test("Issue #48 PR #50 [F1]: SidePanel saveFilePicker enforces hostWhitelist + redirect validation, full-file 200 checks, anti-HTML/manifest poisoning, truncation abort, and idle timeout", async () => {
  const saveFilePicker = await bundleTsModule("../src/downloads/saveFilePicker.ts");
  const allowedOrigins = ["https://snap.dokitool.com"];
  const validateWhitelisted = (u) =>
    hostWhitelist.isWhitelistedMediaUrl(u, allowedOrigins).allowed;

  const makeTrackedHandle = () => {
    let createCalls = 0;
    let closeCalls = 0;
    let abortCalls = 0;
    const writes = [];
    const handle = {
      name: "audit.mp4",
      async createWritable() {
        createCalls++;
        return {
          async write(chunk) { writes.push(new Uint8Array(chunk)); },
          async close() { closeCalls++; },
          async abort() { abortCalls++; },
        };
      },
    };
    return {
      handle,
      stats: () => ({ createCalls, closeCalls, abortCalls, writes }),
    };
  };

  // 1) SidePanelApp.vue enforces isWhitelistedMediaUrl pre-filter and passes validateUrl into streamRoutesToFileHandle
  const sidePanelSrc = await readFile(
    fileURLToPath(new URL("../src/extension/SidePanelApp.vue", import.meta.url)),
    "utf8",
  );
  assert.match(sidePanelSrc, /import\s*\{\s*isWhitelistedMediaUrl\s*\}\s*from\s*["']\.\/hostWhitelist["']/);
  assert.match(sidePanelSrc, /const\s+whitelistedRoutes\s*=\s*single\.spec\.routes\.filter\(validateWhitelistedUrl\)/);
  assert.match(sidePanelSrc, /if\s*\(\s*whitelistedRoutes\.length\s*>\s*0\s*\)/);
  assert.match(sidePanelSrc, /validateUrl:\s*validateWhitelistedUrl/);

  // 2) Non-whitelisted initial URLs, credentials, fragments, manifests, and chrome-extension: relative paths -> 0 fetch, 0 write
  const prevLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
  let blockedFetchCount = 0;
  try {
    Object.defineProperty(globalThis, "location", {
      configurable: true,
      value: {
        protocol: "chrome-extension:",
        origin: `chrome-extension://${DOKITOOL_EXTENSION_ID}`,
      },
    });
    const hBlocked = makeTrackedHandle();
    await assert.rejects(
      saveFilePicker.streamRoutesToFileHandle({
        handle: hBlocked.handle,
        routes: [
          "https://cdn.vimeo.example/video.mp4",
          "https://user:pass@upos-sz-mirrorcos.bilivideo.com/v.mp4",
          "https://upos-sz-mirrorcos.bilivideo.com/v.mp4#frag",
          "https://upos-sz-mirrorcos.bilivideo.com/playlist.m3u8",
          "https://upos-sz-mirrorcos.bilivideo.com/manifest.mpd",
          "/manifest.json",
          "//upos-sz-mirrorcos.bilivideo.com/v.mp4",
        ],
        validateUrl: validateWhitelisted,
        fetchImpl: async () => {
          blockedFetchCount++;
          return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
        },
      }),
      /安全规则/,
    );
    assert.equal(blockedFetchCount, 0, "must make 0 fetch calls for blocked/non-whitelisted/extension-relative routes");
    assert.equal(hBlocked.stats().createCalls, 0);
  } finally {
    if (prevLocation) Object.defineProperty(globalThis, "location", prevLocation);
    else delete globalThis.location;
  }

  // 3) 302 redirect (resp.url) escaping to non-whitelisted or loopback host -> body cancelled, 0 writable calls
  for (const escapedUrl of [
    "https://rogue-redirect.evil.example/payload.mp4",
    "http://127.0.0.1:9999/secret.mp4",
  ]) {
    let bodyCancelled = false;
    const hRedirect = makeTrackedHandle();
    await assert.rejects(
      saveFilePicker.streamRoutesToFileHandle({
        handle: hRedirect.handle,
        routes: ["https://upos-sz-mirrorcos.bilivideo.com/start.mp4"],
        validateUrl: validateWhitelisted,
        fetchImpl: async () => ({
          status: 200,
          ok: true,
          type: "cors",
          url: escapedUrl,
          headers: new Headers({ "content-length": "4" }),
          body: {
            async cancel() { bodyCancelled = true; },
            getReader() { throw new Error("must not read body of rejected redirect"); },
          },
        }),
      }),
      /重定向目标不在安全白名单内/,
    );
    assert.equal(bodyCancelled, true, `must cancel response body for redirected URL ${escapedUrl}`);
    assert.equal(hRedirect.stats().createCalls, 0);
    assert.equal(hRedirect.stats().closeCalls, 0);
  }

  // 4) Non-200 / partial / opaque responses (204, 206, 200+Content-Range) rejected without writing
  for (const badResp of [
    () => ({ status: 204, ok: true, type: "cors", url: "", headers: new Headers(), body: null }),
    () => new Response(new Uint8Array([1, 2]), { status: 206, headers: { "content-range": "bytes 0-1/10" } }),
    () => new Response(new Uint8Array([1, 2]), { status: 200, headers: { "content-range": "bytes 0-1/10" } }),
    () => ({ status: 200, ok: true, type: "opaque", url: "", headers: new Headers(), body: { async cancel() {} } }),
  ]) {
    const hBad = makeTrackedHandle();
    await assert.rejects(
      saveFilePicker.streamRoutesToFileHandle({
        handle: hBad.handle,
        routes: ["https://upos-sz-mirrorcos.bilivideo.com/bad-status.mp4"],
        validateUrl: validateWhitelisted,
        fetchImpl: async () => badResp(),
      }),
      /不是完整文件响应/,
    );
    assert.equal(hBad.stats().createCalls, 0);
    assert.equal(hBad.stats().closeCalls, 0);
  }

  // 5) 200 OK HTML / JSON / #EXTM3U poisoning -> calls writable.abort(), NEVER writable.close()
  for (const payload of [
    "<!DOCTYPE html><html><body>403 Forbidden</body></html>",
    "<html><body>Blocked</body></html>",
    '{"code":403,"message":"denied"}',
    '[{"error":"denied"}]',
    "#EXTM3U\n#EXT-X-VERSION:3\n",
  ]) {
    const bytes = new TextEncoder().encode(payload);
    const hPoison = makeTrackedHandle();
    await assert.rejects(
      saveFilePicker.streamRoutesToFileHandle({
        handle: hPoison.handle,
        routes: ["https://upos-sz-mirrorcos.bilivideo.com/poison.mp4"],
        validateUrl: validateWhitelisted,
        fetchImpl: async () =>
          new Response(bytes, {
            status: 200,
            headers: { "content-length": String(bytes.byteLength) },
          }),
      }),
      /页面或播放清单/,
    );
    assert.equal(hPoison.stats().abortCalls, 1, `poisoned payload must call writable.abort(): ${payload.slice(0, 16)}`);
    assert.equal(hPoison.stats().closeCalls, 0, "poisoned payload must NEVER call writable.close()");
  }

  // 6) Truncated stream (Content-Length mismatch) & 0-byte body -> calls writable.abort(), NEVER writable.close()
  const hTrunc = makeTrackedHandle();
  await assert.rejects(
    saveFilePicker.streamRoutesToFileHandle({
      handle: hTrunc.handle,
      routes: ["https://upos-sz-mirrorcos.bilivideo.com/trunc.mp4"],
      validateUrl: validateWhitelisted,
      fetchImpl: async () => {
        const stream = new ReadableStream({
          start(ctrl) {
            ctrl.enqueue(new Uint8Array([0x00, 0x00, 0x00, 0x18]));
            ctrl.close();
          },
        });
        return new Response(stream, {
          status: 200,
          headers: { "content-length": "1024" },
        });
      },
    }),
    /下载不完整/,
  );
  assert.equal(hTrunc.stats().abortCalls, 1, "truncated stream must call writable.abort()");
  assert.equal(hTrunc.stats().closeCalls, 0, "truncated stream must NEVER call writable.close()");

  const hEmpty = makeTrackedHandle();
  await assert.rejects(
    saveFilePicker.streamRoutesToFileHandle({
      handle: hEmpty.handle,
      routes: ["https://upos-sz-mirrorcos.bilivideo.com/empty.mp4"],
      validateUrl: validateWhitelisted,
      fetchImpl: async () =>
        new Response(new ReadableStream({ start(ctrl) { ctrl.close(); } }), {
          status: 200,
        }),
    }),
    /下载不完整/,
  );
  assert.equal(hEmpty.stats().abortCalls, 1, "0-byte body must call writable.abort()");
  assert.equal(hEmpty.stats().closeCalls, 0, "0-byte body must NEVER call writable.close()");

  // 7) Per-route idle timeout aborts stalled route 1 and falls back cleanly to route 2
  const hTimeoutFallback = makeTrackedHandle();
  let route1Aborted = false;
  const fallbackRes = await saveFilePicker.streamRoutesToFileHandle({
    handle: hTimeoutFallback.handle,
    routes: [
      "https://upos-sz-mirrorcos.bilivideo.com/slow-route.mp4",
      "https://upos-sz-mirrorhw.bilivideo.com/fast-route.mp4",
    ],
    validateUrl: validateWhitelisted,
    idleTimeoutMs: 35,
    fetchImpl: async (url, init) => {
      if (url.includes("slow-route")) {
        return new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () => {
            route1Aborted = true;
            reject(init.signal.reason);
          });
        });
      }
      return new Response(new Uint8Array([0x00, 0x00, 0x00, 0x20]), {
        status: 200,
        headers: { "content-length": "4" },
      });
    },
  });
  assert.equal(route1Aborted, true, "stalled route 1 must be aborted on idle timeout");
    assert.equal(fallbackRes.loaded, 4);
    assert.equal(hTimeoutFallback.stats().closeCalls, 1);
    assert.equal(hTimeoutFallback.stats().abortCalls, 0);
  });

test("Batch 1A (v4.4.1): build-extension --zip-out emits extension-version.json, versionCheck enforces whitelist/no-polling/same-origin download_url, WEB_EXT_PING exposes ONLY useSaveFilePicker, saveFilePicker clears legacy localStorage, and filenameAudit warnings stay < 150 chars", async () => {
  const [versionCheck, filenameAudit, bridgeAndPicker, capabilityHub] = await Promise.all([
    bundleTsModule("../src/extension/versionCheck.ts"),
    bundleTsModule("../src/extension/bg/filenameAudit.ts"),
    (async () => {
      const bundled = await build({
        stdin: {
          contents: `
            export * as saveFilePicker from "./src/downloads/saveFilePicker.ts";
            export * as extensionBridge from "./src/services/extensionBridge.ts";
          `,
          resolveDir: fileURLToPath(new URL("..", import.meta.url)),
          loader: "ts",
        },
        bundle: true,
        write: false,
        platform: "node",
        format: "esm",
      });
      return import(
        `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`
      );
    })(),
    bundleTsModule("../src/core/capabilityHub.ts"),
  ]);
  const { saveFilePicker, extensionBridge: sharedBridge } = bridgeAndPicker;

  const releaseMeta = JSON.parse(
    await readFile(new URL("../src/core/extensionReleaseMeta.json", import.meta.url), "utf8"),
  );
  assert.equal(releaseMeta.version, "4.4.1");
  assert.equal(capabilityHub.LATEST_EXTENSION_VERSION, "4.4.1");

  // (a) build-extension.mjs --zip-out in isolated temp dir writes deterministic extension-version.json
  const tmpRoot = await mkdtemp(join(tmpdir(), "dokitool-batch1a-vermeta-"));
  const frontendDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
  try {
    const extOutDir = join(tmpRoot, "ext");
    const zipOutPath = join(tmpRoot, "helper", "dokitool-chrome-extension.zip");
    const versionJsonPath = join(tmpRoot, "helper", "extension-version.json");
    const cli = spawnSync(
      process.execPath,
      [
        join(frontendDir, "scripts", "build-extension.mjs"),
        "--out-dir",
        extOutDir,
        "--zip-out",
        zipOutPath,
        "--quiet",
      ],
      { cwd: frontendDir, encoding: "utf8" },
    );
    assert.equal(cli.status, 0, `build-extension CLI failed: ${cli.stderr || cli.stdout}`);
    assert.equal(existsSync(zipOutPath), true);
    assert.equal(existsSync(versionJsonPath), true, "expected sibling extension-version.json");

    const rawVersionJson = await readFile(versionJsonPath, "utf8");
    assert.equal(
      rawVersionJson,
      `${JSON.stringify({ version: releaseMeta.version, download_url: "/helper/dokitool-chrome-extension.zip" })}\n`,
    );
    const parsedVersionJson = JSON.parse(rawVersionJson);
    assert.equal(parsedVersionJson.version, releaseMeta.version);
    assert.equal(parsedVersionJson.download_url, "/helper/dokitool-chrome-extension.zip");
  } finally {
    await rm(tmpRoot, { recursive: true, force: true });
  }

  // (b) versionCheck.ts static & runtime security checks
  const versionCheckSrc = await readFile(
    new URL("../src/extension/versionCheck.ts", import.meta.url),
    "utf8",
  );
  const versionCheckLines = versionCheckSrc.trimEnd().split("\n").length;
  assert.ok(versionCheckLines <= 90, `versionCheck.ts must stay <= 90 lines, got ${versionCheckLines}`);
  assert.equal(/\bsetInterval\b/.test(versionCheckSrc), false, "versionCheck.ts must have ZERO setInterval polling");

  // Disallowed origins make ZERO fetch calls
  let disallowedFetches = 0;
  for (const badOrigin of [
    "",
    "https://evil.example.com",
    "https://www.youtube.com",
    "https://upos-sz-mirrorcos.bilivideo.com",
    "http://snap.dokitool.com",
    "http://192.168.1.1:8080",
    "https://snap.dokitool.com/subpath",
  ]) {
    assert.equal(versionCheck.resolveAllowedVersionCheckOrigin(badOrigin), null);
    const res = await versionCheck.checkForExtensionUpdate({
      installedVersion: "4.4.0",
      apiBaseUrl: badOrigin,
      fetchImpl: async () => {
        disallowedFetches += 1;
        return new Response("{}", { status: 200 });
      },
    });
    assert.equal(res, null);
  }
  assert.equal(disallowedFetches, 0, "disallowed origins must trigger zero fetch calls");

  // Allowed official + loopback origins enforce credentials:omit, cache:no-cache, AbortSignal
  const observed = [];
  const validProd = await versionCheck.checkForExtensionUpdate({
    installedVersion: "4.4.0",
    apiBaseUrl: "https://snap.dokitool.com/",
    fetchImpl: async (url, init) => {
      observed.push({ url: String(url), init });
      return new Response(
        JSON.stringify({ version: "4.4.1", download_url: "/helper/dokitool-chrome-extension.zip" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    },
  });
  assert.deepEqual(validProd, {
    latestVersion: "4.4.1",
    downloadUrl: "https://snap.dokitool.com/helper/dokitool-chrome-extension.zip",
  });
  assert.equal(observed.length, 1);
  assert.equal(observed[0].url, "https://snap.dokitool.com/helper/extension-version.json");
  assert.equal(observed[0].init.credentials, "omit");
  assert.equal(observed[0].init.cache, "no-cache");
  assert.ok(observed[0].init.signal instanceof AbortSignal);

  const validLoopback = await versionCheck.checkForExtensionUpdate({
    installedVersion: "4.4.0",
    apiBaseUrl: "http://127.0.0.1:18080",
    fetchImpl: async () =>
      new Response(
        JSON.stringify({ version: "4.5.0", download_url: "/helper/dokitool-chrome-extension.zip" }),
        { status: 200 },
      ),
  });
  assert.deepEqual(validLoopback, {
    latestVersion: "4.5.0",
    downloadUrl: "http://127.0.0.1:18080/helper/dokitool-chrome-extension.zip",
  });

  // Non-same-origin / unexpected-path download_url in remote JSON MUST be rejected
  for (const badDownloadUrl of [
    "https://evil.example.com/dokitool-chrome-extension.zip",
    "https://evil.example.com/helper/dokitool-chrome-extension.zip",
    "//evil.example.com/helper/dokitool-chrome-extension.zip",
    "/other/dokitool-chrome-extension.zip",
    "/helper/dokitool-chrome-extension.zip?x=1",
    "/helper/dokitool-chrome-extension.zip#frag",
    "https://user:pass@snap.dokitool.com/helper/dokitool-chrome-extension.zip",
    "javascript:alert(1)",
    "",
  ]) {
    const res = await versionCheck.checkForExtensionUpdate({
      installedVersion: "4.4.0",
      fetchImpl: async () =>
        new Response(
          JSON.stringify({ version: "4.5.0", download_url: badDownloadUrl }),
          { status: 200 },
        ),
    });
    assert.equal(res, null, `must reject tampered download_url: ${badDownloadUrl}`);
  }

  // Redirect escape on resp.url rejected
  const escapedResp = await versionCheck.checkForExtensionUpdate({
    installedVersion: "4.4.0",
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      url: "https://evil.example.com/helper/extension-version.json",
      async json() {
        return { version: "4.5.0", download_url: "/helper/dokitool-chrome-extension.zip" };
      },
    }),
  });
  assert.equal(escapedResp, null);

  // Silent null on timeout, caller abort, network error, non-2xx, malformed JSON, non-semver, up-to-date
  let timedOutSignalAborted = false;
  const timedOut = await versionCheck.checkForExtensionUpdate({
    installedVersion: "4.4.0",
    timeoutMs: 25,
    fetchImpl: async (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => {
          timedOutSignalAborted = true;
          reject(new DOMException("Aborted", "AbortError"));
        });
      }),
  });
  assert.equal(timedOut, null);
  assert.equal(timedOutSignalAborted, true);

  const preAborted = new AbortController();
  preAborted.abort();
  let abortedFetchCalls = 0;
  assert.equal(
    await versionCheck.checkForExtensionUpdate({
      installedVersion: "4.4.0",
      signal: preAborted.signal,
      fetchImpl: async () => {
        abortedFetchCalls += 1;
        return new Response("{}", { status: 200 });
      },
    }),
    null,
  );
  assert.equal(abortedFetchCalls, 0);

  for (const mock of [
    async () => { throw new TypeError("network down"); },
    async () => new Response("not found", { status: 404 }),
    async () => new Response("not-json", { status: 200 }),
    async () => new Response("[]", { status: 200 }),
    async () => new Response(JSON.stringify({ version: "4.5" }), { status: 200 }),
    async () => new Response(JSON.stringify({ version: "4.5.0-rc1" }), { status: 200 }),
    async () => new Response(JSON.stringify({ version: "4.4.0" }), { status: 200 }),
    async () => new Response(JSON.stringify({ version: "4.3.9" }), { status: 200 }),
  ]) {
    assert.equal(
      await versionCheck.checkForExtensionUpdate({
        installedVersion: "4.4.0",
        fetchImpl: mock,
      }),
      null,
    );
  }

  // (c) WEB_EXT_PING exposes ONLY useSaveFilePicker boolean (zero other settings fields) + saveFilePicker in-memory sync
  const extStore = storage.createExtensionStorage({
    local: storage.createMemoryStorageArea(),
    session: storage.createMemoryStorageArea(),
  });
  await extStore.updateSettings({
    bearerToken: "doki_ping_secret_never_leak",
    apiBaseUrl: "https://custom-gateway.example.com",
    subfolderPrefix: "PrivateFolder",
    batchSaveMode: "zip",
    qualityPreference: "1080p",
    autoFollowTab: true,
    useSaveFilePicker: true,
    theme: "dark",
  });
  const extListeners = [];
  const pingChrome = {
    runtime: {
      id: DOKITOOL_EXTENSION_ID,
      getManifest: () => ({
        version: "4.4.1",
        externally_connectable: { matches: PROD_EXTERNALLY_CONNECTABLE_MATCHES },
      }),
      onMessage: { addListener() {}, removeListener() {} },
      onMessageExternal: {
        addListener(fn) { extListeners.push(fn); },
        removeListener(fn) {
          const i = extListeners.indexOf(fn);
          if (i >= 0) extListeners.splice(i, 1);
        },
      },
      onConnect: { addListener() {}, removeListener() {} },
      sendMessage: async () => ({ ok: true }),
      getContexts: async () => [],
    },
    declarativeNetRequest: { getDynamicRules: async () => [], updateDynamicRules: async () => {} },
    downloads: { download: async () => 1, onChanged: { addListener() {}, removeListener() {} } },
    offscreen: { createDocument: async () => {}, closeDocument: async () => {} },
    action: { setBadgeText() {}, setBadgeBackgroundColor() {} },
  };
  const bg = backgroundMod.createBackgroundController({ chrome: pingChrome, storage: extStore });
  try {
    const pingTrue = await new Promise((resolveResp) => {
      extListeners[0](
        { type: "WEB_EXT_PING" },
        { origin: "https://snap.dokitool.com", url: "https://snap.dokitool.com/" },
        resolveResp,
      );
    });
    assert.equal(pingTrue.ok, true);
    assert.deepEqual(Object.keys(pingTrue.data).sort(), [
      "capabilities",
      "extensionId",
      "useSaveFilePicker",
      "version",
    ]);
    assert.equal(pingTrue.data.useSaveFilePicker, true);
    for (const forbidden of [
      "doki_ping_secret_never_leak",
      "custom-gateway.example.com",
      "PrivateFolder",
      "batchSaveMode",
      "qualityPreference",
      "autoFollowTab",
      "bearerToken",
      "apiBaseUrl",
      "theme",
    ]) {
      assert.equal(
        JSON.stringify(pingTrue).includes(forbidden),
        false,
        `WEB_EXT_PING must NEVER expose ${forbidden}`,
      );
    }

    await extStore.updateSettings({ useSaveFilePicker: false });
    const pingFalse = await new Promise((resolveResp) => {
      extListeners[0](
        { type: "WEB_EXT_PING" },
        { origin: "https://snap.dokitool.com", url: "https://snap.dokitool.com/" },
        resolveResp,
      );
    });
    assert.equal(pingFalse.ok, true);
    assert.equal(pingFalse.data.useSaveFilePicker, false);
  } finally {
    bg.dispose();
  }

  // saveFilePicker in-memory sync & active legacy localStorage cleanup
  const prevWin = globalThis.window;
  const prevChromeGlobal = globalThis.chrome;
  try {
    const lsMap = new Map([[saveFilePicker.WEB_SAVE_FILE_PICKER_PREF_KEY, "1"]]);
    let setItemCalls = 0;
    globalThis.window = {
      localStorage: {
        getItem: (k) => lsMap.get(k) ?? null,
        setItem: (k, v) => { setItemCalls += 1; lsMap.set(k, String(v)); },
        removeItem: (k) => { lsMap.delete(k); },
      },
    };
    saveFilePicker.syncWebSaveFilePickerPreference(false);
    assert.equal(lsMap.has(saveFilePicker.WEB_SAVE_FILE_PICKER_PREF_KEY), false);

    // Re-seed legacy residue and verify readWebSaveFilePickerPreference NEVER trusts it and clears it
    lsMap.set(saveFilePicker.WEB_SAVE_FILE_PICKER_PREF_KEY, "1");
    assert.equal(saveFilePicker.readWebSaveFilePickerPreference(), false);
    assert.equal(lsMap.has(saveFilePicker.WEB_SAVE_FILE_PICKER_PREF_KEY), false);

    // writeWebSaveFilePickerPreference syncs in-memory only and never writes localStorage
    lsMap.set(saveFilePicker.WEB_SAVE_FILE_PICKER_PREF_KEY, "1");
    saveFilePicker.writeWebSaveFilePickerPreference(true);
    assert.equal(saveFilePicker.readWebSaveFilePickerPreference(), true);
    assert.equal(lsMap.has(saveFilePicker.WEB_SAVE_FILE_PICKER_PREF_KEY), false);
    assert.equal(setItemCalls, 0);

    // extensionBridge.pingInstalledExtension syncs in-memory saveFilePicker=true and resets false on disconnect
    saveFilePicker.syncWebSaveFilePickerPreference(false);
    lsMap.set(saveFilePicker.WEB_SAVE_FILE_PICKER_PREF_KEY, "1");
    globalThis.chrome = {
      runtime: {
        sendMessage(_id, _msg, cb) {
          cb({
            ok: true,
            data: {
              version: "4.4.1",
              extensionId: DOKITOOL_EXTENSION_ID,
              capabilities: ["direct_download"],
              useSaveFilePicker: true,
            },
          });
        },
      },
    };
    const pingedOn = await sharedBridge.pingInstalledExtension({ timeoutMs: 200 });
    assert.equal(pingedOn.useSaveFilePicker, true);
    assert.equal(saveFilePicker.readWebSaveFilePickerPreference(), true);
    assert.equal(lsMap.has(saveFilePicker.WEB_SAVE_FILE_PICKER_PREF_KEY), false);

    delete globalThis.chrome;
    const pingedOff = await sharedBridge.pingInstalledExtension({ timeoutMs: 50 });
    assert.equal(pingedOff.connected, false);
    assert.equal(pingedOff.useSaveFilePicker, false);
    assert.equal(saveFilePicker.readWebSaveFilePickerPreference(), false);
    assert.equal(setItemCalls, 0);
  } finally {
    saveFilePicker.syncWebSaveFilePickerPreference(false);
    if (prevWin === undefined) delete globalThis.window;
    else globalThis.window = prevWin;
    if (prevChromeGlobal === undefined) delete globalThis.chrome;
    else globalThis.chrome = prevChromeGlobal;
  }

  // (d) FILENAME_TAMPER_WARNING_ZH & FILENAME_TAMPER_WARNING_EN < 150 chars & aligned names
  assert.ok(
    filenameAudit.FILENAME_TAMPER_WARNING_ZH.length < 150,
    `ZH warning must be < 150 chars, got ${filenameAudit.FILENAME_TAMPER_WARNING_ZH.length}`,
  );
  assert.ok(
    filenameAudit.FILENAME_TAMPER_WARNING_EN.length < 150,
    `EN warning must be < 150 chars, got ${filenameAudit.FILENAME_TAMPER_WARNING_EN.length}`,
  );
  assert.ok(filenameAudit.FILENAME_TAMPER_WARNING_ZH.includes("检测到浏览器内其他下载类扩展改写了保存文件名"));
  assert.ok(filenameAudit.FILENAME_TAMPER_WARNING_ZH.includes("下载时询问保存位置"));
  assert.ok(filenameAudit.FILENAME_TAMPER_WARNING_EN.includes("Ask where to save each file"));
});
