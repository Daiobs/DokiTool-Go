import test from "node:test";
import assert from "node:assert/strict";
import { createSSRApp, h } from "vue";
import { renderToString } from "vue/server-renderer";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { parse, compileScript } from "vue/compiler-sfc";
import { transformWithEsbuild } from "vite";
import {
  LATEST_EXTENSION_VERSION,
  MIN_EXTENSION_TIKTOK_VERSION,
  resolveClientParseRoute,
  resolveExecutionPlan,
} from "../src/core/capabilityHub.ts";
import { inspectDirectFileExtensionTraits } from "../src/core/media/index.ts";
import { buildExtensionDnrRules, EXTENSION_DNR_RULE_IDS } from "../src/extension/dnrRules.ts";
import {
  CDN_REQUEST_DOMAINS,
  CLIENT_PARSE_PAGE_HOST_PERMISSIONS,
  PRODUCTION_HOST_PERMISSIONS,
  buildManifestHostPermissions,
  isWhitelistedMediaUrl,
} from "../src/extension/hostWhitelist.ts";
import {
  TIKTOK_HYDRATION_MAX_BYTES,
  TikTokClientParseError,
  extractTikTokTarget,
  extractTikTokVideoDetailFromHtml,
  fetchTikTokClientPayload,
  isAllowedTikTokMediaCdnUrl,
  isAllowedTikTokParsePageUrl,
  selectTikTokVideoPlayUrls,
} from "../src/extension/tiktokExtensionParser.ts";
import { createApiClient } from "../src/extension/bg/apiClient.ts";
import { createWebExternalBridge } from "../src/extension/bg/webExternalBridge.ts";
import { createExtensionStorage, resetInMemoryExtensionStorage } from "../src/extension/storage.ts";
import { useMediaDownload } from "../src/composables/useMediaDownload.ts";
import { HttpStatusError, useVideoParser } from "../src/composables/useVideoParser.ts";
import { ref } from "vue";

test("DNR RULE 1009 covers all 4 TikTok top-level CDN domains with strict isolation", () => {
  const extId = "ihamkldlkdibleacagiejklpfofapkpo";
  const rules = buildExtensionDnrRules(extId);
  assert.ok(EXTENSION_DNR_RULE_IDS.includes(1009));

  const r1009 = rules.find((r) => r.id === 1009);
  assert.ok(r1009, "Rule 1009 must exist");
  assert.equal(r1009.priority, 2);
  assert.deepEqual(r1009.condition.initiatorDomains, [extId]);
  assert.deepEqual(r1009.condition.requestDomains, [
    "tiktokcdn.com",
    "tiktokcdn-us.com",
    "tiktokcdn-eu.com",
    "tiktokv.com",
  ]);
  assert.deepEqual(r1009.action.requestHeaders, [
    { header: "Referer", operation: "set", value: "https://www.tiktok.com/" },
    { header: "Origin", operation: "remove" },
    { header: "Cookie", operation: "remove" },
  ]);

  const r1005 = rules.find((r) => r.id === 1005);
  for (const dom of r1009.condition.requestDomains) {
    assert.equal(
      r1005.condition.requestDomains.includes(dom),
      false,
      `Rule 1005 must not duplicate ${dom}`,
    );
  }

  for (const cdnUrl of [
    "https://v16-web-newkey.tiktokcdn.com/abc/video/tos/v.mp4",
    "https://v16m-default.tiktokcdn-us.com/abc/video/tos/v.mp4",
    "https://v19-web-newkey.tiktokcdn-eu.com/abc/video/tos/v.mp4",
    "https://v16-cold.tiktokv.com/abc/video/tos/v.mp4",
  ]) {
    assert.equal(isWhitelistedMediaUrl(cdnUrl).allowed, true, `${cdnUrl} must be whitelisted`);
  }
});

test("capabilityHub resolveExecutionPlan blocks browserFetchBlocked without extension instead of falling back to 403 web_sw_stream", () => {
  const traits = inspectDirectFileExtensionTraits({
    routes: ["https://v16m-default.tiktokcdn-us.com/abc/video/tos/v.mp4"],
    source: { access: "direct", browser_fetch: "blocked" },
  });
  assert.equal(traits.browserFetchBlocked, true);
  assert.equal(traits.whitelistedForExtension, true);
  assert.equal(traits.wantsProactiveExtensionDirect, true);

  const disconnectedPlan = resolveExecutionPlan(
    {
      deliveryKind: "file",
      whitelistedForExtension: traits.whitelistedForExtension,
      browserFetchBlocked: traits.browserFetchBlocked,
      requiresRefererOrBlockedFetch: traits.requiresRefererOrBlockedFetch,
    },
    {
      extensionConnected: false,
      extensionVersion: "",
      extensionCapabilities: [],
      swMultiRangeAvailable: true,
    },
  );
  assert.deepEqual(disconnectedPlan, {
    channel: "blocked",
    canDownload: false,
    usesExtension: false,
    requiresUpgradeNotice: true,
    reason: "extension_direct_required",
  });

  const connectedPlan = resolveExecutionPlan(
    {
      deliveryKind: "file",
      whitelistedForExtension: traits.whitelistedForExtension,
      browserFetchBlocked: traits.browserFetchBlocked,
      requiresRefererOrBlockedFetch: traits.requiresRefererOrBlockedFetch,
    },
    {
      extensionConnected: true,
      extensionVersion: LATEST_EXTENSION_VERSION,
      extensionCapabilities: ["direct_download"],
      swMultiRangeAvailable: true,
    },
  );
  assert.equal(connectedPlan.channel, "extension_direct");
  assert.equal(connectedPlan.canDownload, true);
  assert.equal(connectedPlan.usesExtension, true);

  // Non-blocked heuristic (e.g. legacy Bilibili without browser_fetch: "blocked") keeps web_sw_stream fallback
  const heuristicOnly = resolveExecutionPlan(
    {
      deliveryKind: "file",
      whitelistedForExtension: true,
      requiresRefererOrBlockedFetch: true,
      browserFetchBlocked: false,
    },
    {
      extensionConnected: false,
      extensionVersion: "",
      extensionCapabilities: [],
      swMultiRangeAvailable: true,
    },
  );
  assert.equal(heuristicOnly.channel, "web_sw_stream");
});

test("useMediaDownload blocks browser_fetch=blocked without extension (0 Web fetch) and prompts upgrade on outdated extension UNWHITELISTED_CDN", async () => {
  const videoUrl = "https://v16m-default.tiktokcdn-us.com/0123456789abcdef0123456789abcdef/6b09f2e5/video/tos/useast5/1080.mp4";
  const makeFixtureItem = () => ({
    id: "video-1",
    index: 1,
    type: "video",
    state: "ready",
    variants: [
      {
        id: "v-1",
        label: "1080p HEVC",
        metadata: { extension: "mp4", mime_type: "video/mp4", width: 1080, height: 1920, has_audio: true },
        delivery: {
          kind: "file",
          sources: [
            { id: "v-1-src-1", url: videoUrl, access: "direct", browser_fetch: "blocked" },
          ],
        },
      },
    ],
    default: { variant_id: "v-1", source_id: "v-1-src-1", url: videoUrl },
  });

  const makeStore = (item) => {
    const downloads = [];
    let nextId = 1;
    return {
      resultData: { platform: "tiktok", title: "Demo Video", items: [item] },
      resultVersion: 1,
      downloads,
      addDownload(entry) {
        const id = nextId++;
        downloads.push({ id, ...entry });
        return id;
      },
      updateDownload(id, patch) {
        const task = downloads.find((d) => d.id === id);
        if (task) Object.assign(task, patch);
      },
      removeDownload(id) {
        const idx = downloads.findIndex((d) => d.id === id);
        if (idx >= 0) downloads.splice(idx, 1);
      },
    };
  };

  // Case 1: No chrome.runtime -> triggers onRequireExtension, 0 fetch calls, removes placeholder task
  const origChrome = globalThis.chrome;
  const origFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls++;
    throw new Error("should not call Web fetch on browser_fetch=blocked");
  };
  try {
    delete globalThis.chrome;
    const item = makeFixtureItem();
    const store = makeStore(item);
    const toasts = [];
    let requireExtCalls = 0;
    const dl = useMediaDownload({
      videoStore: store,
      showToast: (msg, type) => toasts.push({ msg, type }),
      onRequireExtension: () => { requireExtCalls++; },
      selection: {
        currentVideo: { value: item },
        currentVideoUrl: { value: videoUrl },
        currentSelection: { value: { variant_id: "v-1", source_id: "v-1-src-1" } },
        selectionFor: () => ({ variant_id: "v-1", source_id: "v-1-src-1" }),
        choose: () => {},
      },
      resolveItem: async (i) => i,
    });
    await dl.downloadMainVideo();
    assert.equal(fetchCalls, 0, "must perform 0 Web fetch calls");
    assert.equal(requireExtCalls, 1, "must trigger extension install callback");
    assert.equal(store.downloads.length, 0, "placeholder task must be removed");
    assert.equal(toasts.length, 1);

    // Case 2: Outdated extension (< 4.6.0) connected -> ping succeeds, enqueue returns UNWHITELISTED_CDN -> upgrade toast + callback
    const sentMessages = [];
    globalThis.chrome = {
      runtime: {
        lastError: null,
        sendMessage(_extId, msg, cb) {
          sentMessages.push(msg);
          if (msg.type === "WEB_EXT_PING") {
            cb({
              ok: true,
              data: {
                version: "4.5.2",
                capabilities: ["direct_download"],
              },
            });
            return;
          }
          if (msg.type === "WEB_EXT_ENQUEUE_MEDIA") {
            cb({
              ok: false,
              code: "UNWHITELISTED_CDN",
              error: "Host not in older extension whitelist",
            });
            return;
          }
          cb({ ok: false, code: "UNSUPPORTED_ACTION" });
        },
      },
    };
    const store2 = makeStore(item);
    const toasts2 = [];
    let requireExtCalls2 = 0;
    const dl2 = useMediaDownload({
      videoStore: store2,
      showToast: (msg, type) => toasts2.push({ msg, type }),
      onRequireExtension: () => { requireExtCalls2++; },
      selection: {
        currentVideo: { value: item },
        currentVideoUrl: { value: videoUrl },
        currentSelection: { value: { variant_id: "v-1", source_id: "v-1-src-1" } },
        selectionFor: () => ({ variant_id: "v-1", source_id: "v-1-src-1" }),
        choose: () => {},
      },
      resolveItem: async (i) => i,
    });
    await dl2.downloadMainVideo();
    assert.equal(fetchCalls, 0, "must still perform 0 Web fetch calls");
    assert.equal(requireExtCalls2, 1, "must trigger upgrade modal on outdated UNWHITELISTED_CDN");
    assert.ok(
      toasts2.some((t) => t.msg.includes(LATEST_EXTENSION_VERSION)),
      `expected upgrade toast mentioning ${LATEST_EXTENSION_VERSION}, got ${JSON.stringify(toasts2)}`,
    );
    assert.ok(
      sentMessages.some((m) => m.type === "WEB_EXT_ENQUEUE_MEDIA" && m.payload?.kind === "direct_download"),
    );
  } finally {
    globalThis.fetch = origFetch;
    if (origChrome === undefined) {
      delete globalThis.chrome;
    } else {
      globalThis.chrome = origChrome;
    }
  }
});

test("CapabilityUpgradeNotice renders bilingual extension_direct copy", async () => {
  const sfcPath = new URL("../src/components/result/CapabilityUpgradeNotice.vue", import.meta.url);
  const src = await readFile(sfcPath, "utf8");
  const { descriptor } = parse(src);
  const compiled = compileScript(descriptor, { id: "cun-ext-direct", inlineTemplate: true });
  const js = await transformWithEsbuild(compiled.content, "CapabilityUpgradeNotice.ts", {
    loader: "ts",
    format: "cjs",
  });
  const mod = { exports: {} };
  const require = createRequire(import.meta.url);
  const resultI18n = await import("../src/components/result/resultI18n.ts");
  const capabilityHub = await import("../src/core/capabilityHub.ts");
  new Function("require", "module", "exports", js.code)(
    (id) => {
      if (id === "../AppIcon.vue") return { default: { render: () => h("i") } };
      if (id === "./resultI18n") return resultI18n;
      if (id === "../../core/capabilityHub") return capabilityHub;
      return require(id);
    },
    mod,
    mod.exports,
  );
  const Comp = mod.exports.default;

  const zhHtml = await renderToString(
    createSSRApp({
      render: () => h(Comp, { open: true, isClientMounted: false, mode: "extension_direct", locale: "zh-CN" }),
    }),
  );
  assert.match(zhHtml, /data-notice-mode="extension_direct"/);
  assert.match(zhHtml, /防盗链视频/);

  const enHtml = await renderToString(
    createSSRApp({
      render: () => h(Comp, { open: true, isClientMounted: false, mode: "extension_direct", locale: "en" }),
    }),
  );
  assert.match(enHtml, /referer-protected videos/);
});

test("TikTok parse-page host permissions are physically isolated from media download whitelist & DNR 1010/1011 stay xmlhttprequest-only", () => {
  const prodManifest = buildManifestHostPermissions();
  for (const perm of CLIENT_PARSE_PAGE_HOST_PERMISSIONS) {
    assert.equal(prodManifest.host_permissions.includes(perm), true);
    assert.equal(
      PRODUCTION_HOST_PERMISSIONS.includes(perm),
      false,
      `parse-page host ${perm} must NEVER enter PRODUCTION_HOST_PERMISSIONS`,
    );
  }
  assert.equal(CDN_REQUEST_DOMAINS.includes("tiktok.com"), false);
  assert.equal(CDN_REQUEST_DOMAINS.includes("www.tiktok.com"), false);

  for (const blockedMediaUrl of [
    "https://www.tiktok.com/@i/video/7345678901234567890",
    "https://www.tiktok.com/aweme/v1/play/?video_id=1",
    "https://vm.tiktok.com/ZM8abc123/",
    "https://vt.tiktok.com/ZS9xyz789/",
    "https://m.tiktok.com/v/7345678901234567890.html",
    "https://v16-webapp-prime.tiktok.com/video/tos/a.mp4",
  ]) {
    assert.equal(
      isWhitelistedMediaUrl(blockedMediaUrl).allowed,
      false,
      `${blockedMediaUrl} must NOT pass media download whitelist`,
    );
  }

  const extId = "ihamkldlkdibleacagiejklpfofapkpo";
  const rules = buildExtensionDnrRules(extId);
  assert.ok(EXTENSION_DNR_RULE_IDS.includes(1010));
  assert.ok(EXTENSION_DNR_RULE_IDS.includes(1011));
  const r1010 = rules.find((r) => r.id === 1010);
  const r1011 = rules.find((r) => r.id === 1011);
  assert.equal(r1010.priority, 3);
  assert.deepEqual(r1010.condition.resourceTypes, ["xmlhttprequest"]);
  assert.equal(r1010.condition.urlFilter, "||www.tiktok.com/aweme/v1/play/");
  assert.equal(r1011.priority, 2);
  assert.deepEqual(r1011.condition.resourceTypes, ["xmlhttprequest"]);
  assert.deepEqual(r1011.action.requestHeaders, [
    { header: "Origin", operation: "remove" },
    { header: "Cookie", operation: "remove" },
  ]);
});

test("tiktokExtensionParser: target extraction, Go-parity video tier selection, photo zero-302, shortlinks, WAF & size guard", async () => {
  // 1. Target extraction parity
  assert.deepEqual(
    extractTikTokTarget("https://m.tiktok.com/v/7345678901234567890.html?foo=1"),
    {
      kind: "item",
      itemId: "7345678901234567890",
      canonicalUrl: "https://www.tiktok.com/@i/video/7345678901234567890",
    },
  );
  assert.deepEqual(extractTikTokTarget("https://vm.tiktok.com/ZM8abc123/"), {
    kind: "shortlink",
    shortUrl: "https://vm.tiktok.com/ZM8abc123/",
    shortCode: "vm:ZM8abc123",
  });
  assert.deepEqual(extractTikTokTarget("https://tiktok.com/t/ZT8xyz999/"), {
    kind: "shortlink",
    shortUrl: "https://www.tiktok.com/t/ZT8xyz999/",
    shortCode: "t:ZT8xyz999",
  });
  assert.equal(extractTikTokTarget("https://www.tiktok.com/@creator_only"), null);
  assert.equal(extractTikTokTarget("https://www.tiktok.com/"), null);
  assert.equal(extractTikTokTarget("https://evil.example/@i/video/7345678901234567890"), null);
  assert.equal(extractTikTokTarget("https://@www.tiktok.com/@i/video/7345678901234567890"), null);
  assert.equal(extractTikTokTarget("https://user:pass@www.tiktok.com/@i/video/7345678901234567890"), null);
  assert.deepEqual(
    extractTikTokTarget("https://www.tiktok.com/@creator_demo/video/7345678901234567890?is_from_webapp=1"),
    {
      kind: "item",
      itemId: "7345678901234567890",
      canonicalUrl: "https://www.tiktok.com/@i/video/7345678901234567890",
    },
  );

  // 2. CDN allowlist rejects webapp-prime, tt_chain_token, HTTP, IP
  assert.equal(
    isAllowedTikTokMediaCdnUrl("https://v16-web-newkey.tiktokcdn.com/abc/video/tos/v.mp4"),
    true,
  );
  assert.equal(
    isAllowedTikTokMediaCdnUrl("https://v16-webapp-prime.tiktok.com/video/tos/v.mp4"),
    false,
  );
  assert.equal(
    isAllowedTikTokMediaCdnUrl("https://v16-web-newkey.tiktokcdn.com/v.mp4?tk=tt_chain_token"),
    false,
  );
  assert.equal(isAllowedTikTokMediaCdnUrl("http://v16.tiktokcdn.com/v.mp4"), false);
  assert.equal(isAllowedTikTokMediaCdnUrl("https://127.0.0.1/v.mp4"), false);

  // 3. Parity with Go backend/internal/platform/tiktok/testdata/video_post.html
  const videoHtml = await readFile(
    new URL("../../backend/internal/platform/tiktok/testdata/video_post.html", import.meta.url),
    "utf8",
  );
  const photoHtml = await readFile(
    new URL("../../backend/internal/platform/tiktok/testdata/photo_post.html", import.meta.url),
    "utf8",
  );
  const wafHtml = await readFile(
    new URL("../../backend/internal/platform/tiktok/testdata/slardar_waf.html", import.meta.url),
    "utf8",
  );
  const status10204Html = await readFile(
    new URL("../../backend/internal/platform/tiktok/testdata/status_10204.html", import.meta.url),
    "utf8",
  );

  const parsedDetail = extractTikTokVideoDetailFromHtml(videoHtml);
  assert.equal(parsedDetail.found, true);
  const selectedUrls = selectTikTokVideoPlayUrls(
    parsedDetail.detail.itemInfo.itemStruct.video,
  );
  assert.deepEqual(selectedUrls, [
    "https://www.tiktok.com/aweme/v1/play/?video_id=tier_1080_hevc",
    "https://www.tiktok.com/aweme/v1/play/?video_id=tier_720_hevc",
    "https://www.tiktok.com/aweme/v1/play/?video_id=tier_540_h264",
    "https://www.tiktok.com/aweme/v1/play/?video_id=tier_360_low",
  ]);

  const makeMockResponse = (body, { status = 200, url }) => {
    let cancelled = false;
    const resp = new Response(body, { status });
    Object.defineProperty(resp, "url", { value: url, configurable: true });
    if (resp.body) {
      const origCancel = resp.body.cancel.bind(resp.body);
      resp.body.cancel = async () => {
        cancelled = true;
        return origCancel();
      };
    }
    return { resp, wasCancelled: () => cancelled };
  };

  // 4. Video Mode end-to-end fetch: 0 cookies, play302 body cancelled immediately, rejects webapp-prime
  const seenCalls = [];
  const cancelChecks = [];
  const videoResult = await fetchTikTokClientPayload(
    { url: "https://www.tiktok.com/@creator_demo/video/7345678901234567890" },
    {
      fetchImpl: async (url, init) => {
        assert.equal(init.credentials, "omit");
        assert.equal(init.referrerPolicy, "no-referrer");
        seenCalls.push(String(url));
        if (String(url) === "https://www.tiktok.com/@i/video/7345678901234567890") {
          return makeMockResponse(videoHtml, { url: String(url) }).resp;
        }
        if (String(url).includes("tier_1080_hevc")) {
          const m = makeMockResponse("MP4DATA", {
            url: "https://v16m-default.tiktokcdn-us.com/0123456789abcdef0123456789abcdef/6b09f2e5/video/tos/useast5/1080.mp4",
          });
          cancelChecks.push(m.wasCancelled);
          return m.resp;
        }
        if (String(url).includes("tier_720_hevc")) {
          // Simulate disallowed webapp-prime redirect -> must be filtered out
          const m = makeMockResponse("PRIME", {
            url: "https://v16-webapp-prime.tiktok.com/video/tos/prime720.mp4",
          });
          cancelChecks.push(m.wasCancelled);
          return m.resp;
        }
        const m = makeMockResponse("MP4DATA", {
          url: "https://v19-web-newkey.tiktokcdn-eu.com/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/6b09f2e5/video/tos/no1a/540.mp4",
        });
        cancelChecks.push(m.wasCancelled);
        return m.resp;
      },
    },
  );
  assert.equal(videoResult.source_url, "https://www.tiktok.com/@i/video/7345678901234567890");
  // tier_1080_hevc + deduplicated tier_540_h264/tier_360_low (tier_720 webapp-prime dropped)
  assert.equal(videoResult.resolved_tiers.length, 2);
  assert.ok(cancelChecks.every((fn) => fn() === true), "every play302 response body must be cancelled immediately");

  // 5. Photo Mode: 0 play302 calls, shortlink reuses landed www.tiktok.com HTML in 1 round-trip
  let photoFetchCount = 0;
  const photoResult = await fetchTikTokClientPayload(
    { url: "https://vm.tiktok.com/ZM8photo01/" },
    {
      fetchImpl: async (url) => {
        photoFetchCount++;
        assert.equal(String(url), "https://vm.tiktok.com/ZM8photo01/");
        return makeMockResponse(photoHtml, {
          url: "https://www.tiktok.com/@photo_artist/photo/7399999999999999999",
        }).resp;
      },
    },
  );
  assert.equal(photoFetchCount, 1, "shortlink landing directly on www.tiktok.com should reuse HTML without duplicate fetch");
  assert.equal(photoResult.source_url, "https://www.tiktok.com/@i/video/7399999999999999999");
  assert.deepEqual(photoResult.resolved_tiers, []);

  // 6. Failure modes: SlardarWAF, statusCode 10204, dead shortlink, foreign redirect, > 4 MiB body
  await assert.rejects(
    () =>
      fetchTikTokClientPayload(
        { url: "https://www.tiktok.com/@a/video/7345678901234567890" },
        {
          fetchImpl: async (url) => makeMockResponse(wafHtml, { url: String(url) }).resp,
        },
      ),
    (err) => err instanceof TikTokClientParseError && err.code === "UPSTREAM_BLOCKED",
  );

  await assert.rejects(
    () =>
      fetchTikTokClientPayload(
        { url: "https://www.tiktok.com/@a/video/7345678901234567890" },
        {
          fetchImpl: async (url) => makeMockResponse(status10204Html, { url: String(url) }).resp,
        },
      ),
    (err) => err instanceof TikTokClientParseError && err.code === "CONTENT_UNAVAILABLE",
  );

  await assert.rejects(
    () =>
      fetchTikTokClientPayload(
        { url: "https://vm.tiktok.com/ZM8dead00/" },
        {
          fetchImpl: async () =>
            makeMockResponse("<html>home</html>", { url: "https://www.tiktok.com/?_r=1" }).resp,
        },
      ),
    (err) => err instanceof TikTokClientParseError && err.code === "CONTENT_UNAVAILABLE",
  );

  await assert.rejects(
    () =>
      fetchTikTokClientPayload(
        { url: "https://vm.tiktok.com/ZM8evil00/" },
        {
          fetchImpl: async () =>
            makeMockResponse("<html>evil</html>", { url: "https://evil.example/@i/video/123456" }).resp,
        },
      ),
    (err) => err instanceof TikTokClientParseError && err.code === "UPSTREAM_UNAVAILABLE",
  );

  await assert.rejects(
    () =>
      fetchTikTokClientPayload(
        { url: "https://www.tiktok.com/@a/video/7345678901234567890" },
        {
          fetchImpl: async (url) =>
            makeMockResponse(new Uint8Array(TIKTOK_HYDRATION_MAX_BYTES + 16), { url: String(url) }).resp,
        },
      ),
    (err) => err instanceof TikTokClientParseError && err.code === "UPSTREAM_INVALID_RESPONSE",
  );
});

test("WEB_EXT_PARSE_TIKTOK enforces zero-secret, validates target, and SidePanel routes TikTok via Offscreen + /api/tiktok/finalize", async () => {
  resetInMemoryExtensionStorage();
  const storage = createExtensionStorage();
  await storage.updateSettings({
    apiBaseUrl: "https://snap.dokitool.com",
    bearerToken: "dkt_super_secret_owner_token_must_never_leak",
  });

  const finalizedMedia = {
    schema_version: "1.0",
    code: "OK",
    data: {
      platform: "tiktok",
      content_id: "7399999999999999999",
      source_url: "https://www.tiktok.com/@i/video/7399999999999999999",
      title: "Kyoto Autumn Photo Carousel",
      default_item_id: "image-1",
      items: [
        {
          id: "image-1",
          index: 1,
          type: "image",
          state: "ready",
          variants: [
            {
              id: "img-1-orig",
              label: "原图",
              metadata: { extension: "jpg", mime_type: "image/jpeg", evidence: "upstream" },
              delivery: {
                kind: "file",
                sources: [
                  {
                    id: "img-1-src-1",
                    url: "https://p16-common-sign.tiktokcdn-us.com/tos-useast5/img1.jpeg",
                    access: "direct",
                    browser_fetch: "allowed",
                  },
                ],
              },
            },
          ],
          default: {
            variant_id: "img-1-orig",
            source_id: "img-1-src-1",
            url: "https://p16-common-sign.tiktokcdn-us.com/tos-useast5/img1.jpeg",
          },
        },
      ],
    },
  };

  const apiRequests = [];
  const offscreenReqs = [];
  const chromeApi = {
    runtime: {
      id: "ihamkldlkdibleacagiejklpfofapkpo",
      getManifest: () => ({
        version: LATEST_EXTENSION_VERSION,
        externally_connectable: { matches: ["https://snap.dokitool.com/*"] },
      }),
    },
  };
  const apiClient = createApiClient({
    chromeApi,
    storage,
    fetchFn: async (url, init) => {
      apiRequests.push({ url: String(url), init });
      if (String(url).includes("/api/tiktok/finalize")) {
        return new Response(JSON.stringify(finalizedMedia), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ schema_version: "1.0", code: "INVALID_INPUT", error: { code: "INVALID_INPUT", message: "unexpected" } }), { status: 404 });
    },
    nowFn: () => Date.now(),
    syncDynamicDnrRules: async () => [],
    sendToOffscreen: async (req) => {
      offscreenReqs.push(req);
      return {
        result: {
          source_url: "https://www.tiktok.com/@i/video/7399999999999999999",
          video_detail: { statusCode: 0, itemInfo: { itemStruct: { id: "7399999999999999999" } } },
          resolved_tiers: [],
        },
      };
    },
  });

  const bridge = createWebExternalBridge({
    chromeApi,
    storage,
    tasks: new Map(),
    webBridgeTaskIds: new Set(),
    parseYouTubeViaOffscreen: apiClient.parseYouTubeViaOffscreen,
    parseTikTokViaOffscreen: apiClient.parseTikTokViaOffscreen,
    enqueueDownloadItems: async () => ({ taskIds: [], tasks: [] }),
    cancelTaskById: async (id) => ({ taskId: id, cancelled: false }),
  });

  const sendExt = (msg) =>
    new Promise((resolve) => {
      bridge.handleExternalRuntimeMessage(
        msg,
        { origin: "https://snap.dokitool.com", url: "https://snap.dokitool.com/" },
        resolve,
      );
    });

  // 1. Invalid TikTok profile URL rejected immediately with INVALID_INPUT
  const badResp = await sendExt({
    type: "WEB_EXT_PARSE_TIKTOK",
    url: "https://www.tiktok.com/@creator_only",
  });
  assert.equal(badResp.ok, false);
  assert.equal(badResp.code, "INVALID_INPUT");
  assert.equal(offscreenReqs.length, 0);

  // 2. Valid TikTok URL executes Offscreen fetch + POST /api/tiktok/finalize with ZERO Authorization secret
  const okResp = await sendExt({
    type: "WEB_EXT_PARSE_TIKTOK",
    url: "https://www.tiktok.com/@photo_artist/photo/7399999999999999999",
  });
  assert.equal(okResp.ok, true);
  assert.equal(okResp.data.media.platform, "tiktok");
  assert.equal(offscreenReqs.length, 1);
  assert.equal(offscreenReqs[0].type, "OFFSCREEN_TIKTOK_FETCH");
  assert.equal(apiRequests.length, 1);
  assert.equal(apiRequests[0].url, "https://snap.dokitool.com/api/tiktok/finalize?schema_version=1.0");
  assert.equal(
    apiRequests[0].init.headers.Authorization,
    undefined,
    "WEB_EXT_PARSE_TIKTOK must NEVER attach owner bearerToken",
  );
  assert.equal(
    JSON.stringify(okResp).includes("dkt_super_secret_owner_token_must_never_leak"),
    false,
  );
});

test("useVideoParser TikTok routing: with v4.7.0+ extension, without extension, outdated v4.6.0, mobile, accurate error attribution & YouTube non-regression", async () => {
  assert.equal(
    resolveClientParseRoute(
      true,
      { extensionConnected: true, extensionVersion: "4.6.0", extensionCapabilities: ["youtube_parse"] },
      "tiktok_parse",
    ).channel,
    "server_api",
  );
  assert.equal(
    resolveClientParseRoute(
      true,
      { extensionConnected: true, extensionVersion: MIN_EXTENSION_TIKTOK_VERSION, extensionCapabilities: ["tiktok_parse"] },
      "tiktok_parse",
    ).channel,
    "extension_client_parse",
  );

  const sampleMedia = {
    platform: "tiktok",
    content_id: "7399999999999999999",
    source_url: "https://www.tiktok.com/@i/video/7399999999999999999",
    title: "Demo TikTok",
    items: [
      {
        id: "image-1",
        type: "image",
        state: "ready",
        variants: [
          {
            id: "v-1",
            delivery: {
              kind: "file",
              sources: [{ url: "https://p16-common-sign.tiktokcdn-us.com/img.jpeg", browser_fetch: "allowed" }],
            },
          },
        ],
        default: { variant_id: "v-1", url: "https://p16-common-sign.tiktokcdn-us.com/img.jpeg" },
      },
    ],
  };

  const makeStore = () => ({
    resultData: null,
    resultVersion: 0,
    setResult(d) {
      this.resultData = d;
      this.resultVersion++;
    },
    clearResult() {
      this.resultData = null;
    },
  });

  const origFetch = globalThis.fetch;
  try {
    // Case A: Connected v4.7.0+ extension with tiktok_parse -> 0 /api/parse calls, sets result
    let serverFetchCalls = 0;
    globalThis.fetch = async () => {
      serverFetchCalls++;
      throw new Error("should not hit /api/parse when tiktok_parse extension succeeds");
    };
    const storeA = makeStore();
    const parserA = useVideoParser({
      videoStore: storeA,
      locale: ref("zh-CN"),
      showToast: () => {},
      pingExtension: async () => ({
        connected: true,
        version: LATEST_EXTENSION_VERSION,
        extensionId: "ihamkldlkdibleacagiejklpfofapkpo",
        capabilities: ["dash_mux", "direct_download", "youtube_parse", "youtube_mux", "tiktok_parse"],
        useSaveFilePicker: false,
      }),
      parseTikTokViaExtension: async () => ({ ok: true, data: { media: sampleMedia } }),
    });
    parserA.inputUrl.value = "https://www.tiktok.com/@photo_artist/photo/7399999999999999999";
    await parserA.parseVideo();
    assert.equal(serverFetchCalls, 0);
    assert.equal(storeA.resultData?.platform, "tiktok");
    assert.equal(parserA.extensionErrorAction.value, "");

    // Case B: Connected v4.7.0+ extension returns CONTENT_UNAVAILABLE -> exact error, NOT "install extension"
    const storeB = makeStore();
    const parserB = useVideoParser({
      videoStore: storeB,
      locale: ref("zh-CN"),
      showToast: () => {},
      pingExtension: async () => ({
        connected: true,
        version: LATEST_EXTENSION_VERSION,
        extensionId: "ihamkldlkdibleacagiejklpfofapkpo",
        capabilities: ["tiktok_parse"],
        useSaveFilePicker: false,
      }),
      parseTikTokViaExtension: async () => ({
        ok: false,
        code: "CONTENT_UNAVAILABLE",
        status: 404,
        error: "该 TikTok 作品已删除、设为私密或当前区域不可见",
      }),
    });
    parserB.inputUrl.value = "https://www.tiktok.com/@a/video/7345678901234567890";
    await parserB.parseVideo();
    assert.equal(serverFetchCalls, 0);
    assert.match(parserB.parseError.value, /已删除/);
    assert.equal(parserB.extensionErrorAction.value, "");

    // Case C: No extension + server returns 403 UPSTREAM_BLOCKED -> accurate install prompt + action="install"
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          schema_version: "1.0",
          code: "UPSTREAM_BLOCKED",
          error: { code: "UPSTREAM_BLOCKED", message: "TikTok 当前触发访问验证，请稍后重试", retryable: true },
        }),
        { status: 403, headers: { "Content-Type": "application/json" } },
      );
    const storeC = makeStore();
    const parserC = useVideoParser({
      videoStore: storeC,
      locale: ref("zh-CN"),
      showToast: () => {},
      pingExtension: async () => ({
        connected: false,
        version: "",
        extensionId: "",
        capabilities: [],
        useSaveFilePicker: false,
      }),
    });
    parserC.inputUrl.value = "https://www.tiktok.com/@a/video/7345678901234567890";
    await parserC.parseVideo();
    assert.match(parserC.parseError.value, /v4\.7\.0\+/);
    assert.equal(parserC.extensionErrorAction.value, "install");

    // Case D: Outdated v4.6.0 extension (lacking tiktok_parse) + server 403 -> accurate upgrade prompt + action="upgrade"
    const storeD = makeStore();
    const parserD = useVideoParser({
      videoStore: storeD,
      locale: ref("zh-CN"),
      showToast: () => {},
      pingExtension: async () => ({
        connected: true,
        version: "4.6.0",
        extensionId: "ihamkldlkdibleacagiejklpfofapkpo",
        capabilities: ["dash_mux", "direct_download", "youtube_parse", "youtube_mux"],
        useSaveFilePicker: false,
      }),
    });
    parserD.inputUrl.value = "https://www.tiktok.com/@a/video/7345678901234567890";
    await parserD.parseVideo();
    assert.match(parserD.parseError.value, /v4\.6\.0/);
    assert.match(parserD.parseError.value, /v4\.7\.0\+/);
    assert.equal(parserD.extensionErrorAction.value, "upgrade");

    // Case E: No extension + server returns 404 CONTENT_UNAVAILABLE -> exact error, NEVER misattributes to missing extension!
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          schema_version: "1.0",
          code: "CONTENT_UNAVAILABLE",
          error: { code: "CONTENT_UNAVAILABLE", message: "该 TikTok 作品不可见或已被删除", retryable: false },
        }),
        { status: 404, headers: { "Content-Type": "application/json" } },
      );
    const storeE = makeStore();
    const parserE = useVideoParser({
      videoStore: storeE,
      locale: ref("zh-CN"),
      showToast: () => {},
      pingExtension: async () => ({
        connected: false,
        version: "",
        extensionId: "",
        capabilities: [],
        useSaveFilePicker: false,
      }),
    });
    parserE.inputUrl.value = "https://www.tiktok.com/@a/video/7345678901234567890";
    await parserE.parseVideo();
    assert.equal(parserE.parseError.value, "该 TikTok 作品不可见或已被删除");
    assert.equal(parserE.extensionErrorAction.value, "");

    // Case F: No extension + proxy-enabled server returns 200 OK -> succeeds cleanly!
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({ schema_version: "1.0", code: "OK", data: sampleMedia }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    const storeF = makeStore();
    const parserF = useVideoParser({
      videoStore: storeF,
      locale: ref("zh-CN"),
      showToast: () => {},
      pingExtension: async () => ({
        connected: false,
        version: "",
        extensionId: "",
        capabilities: [],
        useSaveFilePicker: false,
      }),
    });
    parserF.inputUrl.value = "https://www.tiktok.com/@a/photo/7399999999999999999";
    await parserF.parseVideo();
    assert.equal(storeF.resultData?.platform, "tiktok");
    assert.equal(parserF.parseError.value, "");

    // Case G (P1-3 regression): Non-TikTok URLs containing "tiktok.com" in query or path MUST NOT be hijacked to TikTok helper!
    const nonTikTokUrls = [
      "https://x.com/user/status/123456789?ref=https://www.tiktok.com/@a/video/7345678901234567890",
      "https://vimeo.com/tiktok.com",
      "https://weibo.com/12345/abc?from=tiktok.com",
    ];
    for (const nonTtUrl of nonTikTokUrls) {
      let extTikTokCalled = false;
      let standardParseUrls = [];
      globalThis.fetch = async (u) => {
        standardParseUrls.push(String(u));
        return new Response(
          JSON.stringify({
            schema_version: "1.0",
            code: "OK",
            data: { ...sampleMedia, platform: "x", source_url: nonTtUrl },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      };
      const storeG = makeStore();
      const parserG = useVideoParser({
        videoStore: storeG,
        locale: ref("zh-CN"),
        showToast: () => {},
        pingExtension: async () => ({
          connected: true,
          version: "4.7.0",
          extensionId: "ihamkldlkdibleacagiejklpfofapkpo",
          capabilities: ["dash_mux", "direct_download", "youtube_parse", "youtube_mux", "tiktok_parse"],
          useSaveFilePicker: false,
        }),
        parseTikTokViaExtension: async () => {
          extTikTokCalled = true;
          return { ok: false, code: "INVALID_INPUT", error: "should never be called" };
        },
      });
      parserG.inputUrl.value = nonTtUrl;
      await parserG.parseVideo();
      assert.equal(extTikTokCalled, false, `Non-TikTok URL must not route to TikTok helper: ${nonTtUrl}`);
      assert.equal(standardParseUrls.length, 1, `Expected standard /api/parse for ${nonTtUrl}`);
      assert.equal(parserG.parseError.value, "");
    }
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("Internal review P1/P2 regressions: CDN/host parity, isTikTokUrl, abort/timeout in Offscreen fetch & apiClient", async () => {
  // 1. isTikTokUrl protocol & trailing-dot hardening
  const { isTikTokUrl } = await import("../src/utils/parseHelpers.ts");
  assert.equal(isTikTokUrl("https://www.tiktok.com./@i/video/7345678901234567890"), true);
  assert.equal(isTikTokUrl("javascript://tiktok.com/%0aalert(1)"), false);
  assert.equal(isTikTokUrl("https://x.com/i/status/1?ref=https://www.tiktok.com/@i/video/12345"), false);

  // 2. P2-6: TIKTOK_PARSE_ALLOWED_HOSTS excludes bare tiktok.com (aligned with manifest + DNR 1011)
  assert.equal(isAllowedTikTokParsePageUrl("https://tiktok.com/@i/video/7345678901234567890"), false);
  assert.equal(isAllowedTikTokParsePageUrl("https://www.tiktok.com/@i/video/7345678901234567890"), true);

  // 3. P1-1 & P2-6: isAllowedTikTokMediaCdnUrl rejects case/semicolon/malformed-percent chain token bypasses, bad DNS labels, non-ASCII
  for (const badCdn of [
    "https://v16-web-newkey.tiktokcdn.com/v.mp4?TK=tt_chain_token",
    "https://v16-web-newkey.tiktokcdn.com/v.mp4?a=1;b=2&tk=tt_chain_token",
    "https://v16-web-newkey.tiktokcdn.com/v.mp4?bad=%ZZ&tk=TT_CHAIN_TOKEN",
    "https://_bad.tiktokcdn.com/v.mp4",
    "https://..tiktokcdn.com/v.mp4",
    "https://v16-web-newkey.tiktokcdn.com/café.mp4",
  ]) {
    assert.equal(isAllowedTikTokMediaCdnUrl(badCdn), false, `Expected rejected CDN URL: ${badCdn}`);
  }

  // 4. P2-4: Mid-stream body read abort -> USER_CANCELLED, and play302 timeout -> UPSTREAM_TIMEOUT (504)
  const videoHtml = await readFile(
    new URL("../../backend/internal/platform/tiktok/testdata/video_post.html", import.meta.url),
    "utf8",
  );
  const bodyAbortCtrl = new AbortController();
  await assert.rejects(
    () =>
      fetchTikTokClientPayload(
        { url: "https://www.tiktok.com/@i/video/7345678901234567890" },
        {
          signal: bodyAbortCtrl.signal,
          fetchImpl: async (u) => {
            const stream = new ReadableStream({
              pull() {
                bodyAbortCtrl.abort();
                return Promise.reject(new DOMException("Aborted", "AbortError"));
              },
            });
            const r = new Response(stream, { status: 200 });
            Object.defineProperty(r, "url", { value: String(u), configurable: true });
            return r;
          },
        },
      ),
    (err) => err instanceof TikTokClientParseError && err.code === "USER_CANCELLED",
  );

  // play302 phase parent abort after first tier resolves must still throw USER_CANCELLED instead of returning partial tiers
  const playAbortCtrl = new AbortController();
  let playCalls = 0;
  await assert.rejects(
    () =>
      fetchTikTokClientPayload(
        { url: "https://www.tiktok.com/@i/video/7345678901234567890" },
        {
          signal: playAbortCtrl.signal,
          fetchImpl: async (u) => {
            const s = String(u);
            if (s.includes("/@i/video/")) {
              const r = new Response(videoHtml, { status: 200 });
              Object.defineProperty(r, "url", { value: s, configurable: true });
              return r;
            }
            playCalls += 1;
            if (playCalls === 1) {
              playAbortCtrl.abort();
              const r = new Response("MP4", { status: 200 });
              Object.defineProperty(r, "url", {
                value: "https://v16m-default.tiktokcdn-us.com/a/b/video/tos/1080.mp4",
                configurable: true,
              });
              return r;
            }
            throw new DOMException("Aborted", "AbortError");
          },
        },
      ),
    (err) => err instanceof TikTokClientParseError && err.code === "USER_CANCELLED",
  );

  // 5. P2-5: parseTikTokViaOffscreen checks signal?.aborted before and after OFFSCREEN_TIKTOK_FETCH
  resetInMemoryExtensionStorage();
  const storage = createExtensionStorage();
  let offscreenCalled = 0;
  let stage2Emitted = false;
  const apiClient = createApiClient({
    chromeApi: {
      runtime: {
        id: "ihamkldlkdibleacagiejklpfofapkpo",
        getManifest: () => ({ version: LATEST_EXTENSION_VERSION }),
      },
    },
    storage,
    fetchFn: async () => new Response("{}", { status: 200 }),
    nowFn: () => Date.now(),
    syncDynamicDnrRules: async () => [],
    sendToOffscreen: async () => {
      offscreenCalled += 1;
      midAbort.abort();
      return {
        result: {
          source_url: "https://www.tiktok.com/@i/video/7399999999999999999",
          video_detail: {},
          resolved_tiers: [],
        },
      };
    },
    onParseProgress: (stage) => {
      if (stage === 2) stage2Emitted = true;
    },
  });
  const preAbort = new AbortController();
  preAbort.abort();
  await assert.rejects(
    () =>
      apiClient.parseTikTokViaOffscreen({
        url: "https://www.tiktok.com/@i/video/7399999999999999999",
        apiOrigin: "https://snap.dokitool.com",
        authSettings: { bearerToken: "" },
        signal: preAbort.signal,
      }),
    (err) => err instanceof Error && err.name === "AbortError",
  );
  assert.equal(offscreenCalled, 0, "pre-aborted signal must not invoke OFFSCREEN_TIKTOK_FETCH");

  const midAbort = new AbortController();
  await assert.rejects(
    () =>
      apiClient.parseTikTokViaOffscreen({
        url: "https://www.tiktok.com/@i/video/7399999999999999999",
        apiOrigin: "https://snap.dokitool.com",
        authSettings: { bearerToken: "" },
        signal: midAbort.signal,
      }),
    (err) => err instanceof Error && err.name === "AbortError",
  );
  assert.equal(offscreenCalled, 1);
  assert.equal(stage2Emitted, false, "mid-aborted signal must not emit stage-2 progress or POST finalize");
});
