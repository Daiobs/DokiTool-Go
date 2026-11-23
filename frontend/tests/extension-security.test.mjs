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
  buildExtension,
  createDeterministicZipBuffer,
  packageExtensionZip,
  verifyExtensionDist,
  verifyExtensionZip,
} from "../scripts/build-extension.mjs";

let hostWhitelist;
let dnrRules;
let urlMatcher;
let storage;
let protocol;
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
  [hostWhitelist, dnrRules, urlMatcher, storage, protocol, youtubeHelperSource] =
    await Promise.all([
      bundleTsModule("../src/extension/hostWhitelist.ts"),
      bundleTsModule("../src/extension/dnrRules.ts"),
      bundleTsModule("../src/extension/urlMatcher.ts"),
      bundleTsModule("../src/extension/storage.ts"),
      bundleTsModule("../src/extension/protocol.ts"),
      readFile(
        new URL("../src/utils/youtubeHelperCore.js", import.meta.url),
        "utf8",
      ),
    ]);
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

test("dnrRules: pins initiatorDomains=[extensionId] on every rule and configures Rules 1001-1005", () => {
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
    [1001, 1002, 1003, 1004, 1005],
  );

  for (const rule of rules) {
    assert.deepEqual(
      rule.condition.initiatorDomains,
      [extId],
      `rule ${rule.id} must scope initiatorDomains strictly to [extensionId]`,
    );
    assert.equal(rule.action.type, "modifyHeaders");
  }

  const [r1001, r1002, r1003, r1004, r1005] = rules;

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

  // Rule 1004: Bilibili Referer + remove Origin/Cookie
  assert.equal(r1004.priority, 2);
  assert.deepEqual(r1004.condition.requestDomains, [
    "bilivideo.com",
    "bilivideo.cn",
    "hdslb.com",
    "akamaized.net",
  ]);
  assert.deepEqual(r1004.action.requestHeaders, [
    { header: "Referer", operation: "set", value: "https://www.bilibili.com/" },
    { header: "Origin", operation: "remove" },
    { header: "Cookie", operation: "remove" },
  ]);

  // Rule 1005: Remaining CDNs + prod/loopback/custom API origins
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

    // A --dev-loopback build MUST be rejected by the production security gate!
    await assert.rejects(
      () => verifyExtensionDist(devOut, { devLoopback: false }),
      /127\.0\.0\.1|localhost/,
    );

    // Tampering with permissions, <all_urls>, content_scripts, or external scripts MUST fail verifyExtensionDist!
    const manifestPath = join(prodOut, "manifest.json");
    const origManifestText = await readFile(manifestPath, "utf8");

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

  // DNR Rule 1004 injects Referer: https://www.bilibili.com/, removes Origin & Cookie, and pins initiatorDomains
  const rules = dnrRules.buildExtensionDnrRules("abcdefghijklmnopabcdefghijklmnop");
  const biliRule = rules.find((r) => r.id === 1004);
  assert.ok(biliRule, "DNR Rule 1004 must exist for Bilibili DASH");
  assert.deepEqual(biliRule.condition.initiatorDomains, [
    "abcdefghijklmnopabcdefghijklmnop",
  ]);
  for (const domain of ["bilivideo.com", "bilivideo.cn", "hdslb.com", "akamaized.net"]) {
    assert.ok(
      biliRule.condition.requestDomains.includes(domain),
      `DNR Rule 1004 must cover ${domain}`,
    );
  }
  assert.deepEqual(biliRule.action.requestHeaders, [
    { header: "Referer", operation: "set", value: "https://www.bilibili.com/" },
    { header: "Origin", operation: "remove" },
    { header: "Cookie", operation: "remove" },
  ]);
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
