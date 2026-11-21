import test, { before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build, stop } from "esbuild";
import {
  buildExtension,
  verifyExtensionDist,
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
  } finally {
    await rm(prodOut, { recursive: true, force: true });
    await rm(devOut, { recursive: true, force: true });
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
