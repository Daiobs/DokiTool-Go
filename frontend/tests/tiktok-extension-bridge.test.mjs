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
  resolveExecutionPlan,
} from "../src/core/capabilityHub.ts";
import { inspectDirectFileExtensionTraits } from "../src/core/media/index.ts";
import { buildExtensionDnrRules, EXTENSION_DNR_RULE_IDS } from "../src/extension/dnrRules.ts";
import { isWhitelistedMediaUrl } from "../src/extension/hostWhitelist.ts";
import { useMediaDownload } from "../src/composables/useMediaDownload.ts";

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
