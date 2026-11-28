import test from "node:test";
import assert from "node:assert/strict";
import { createSSRApp, h, reactive } from "vue";
import { renderToString } from "vue/server-renderer";
import {
  isCorsBlockedDirectUrl,
  inspectDirectFileExtensionTraits,
} from "../src/core/media/index.ts";
import { resolveExecutionPlan } from "../src/core/capabilityHub.ts";
import { isWhitelistedMediaUrl } from "../src/extension/hostWhitelist.ts";
import { createPublicDownloadActions } from "../src/composables/download/archive.ts";
import { loadSfc, loadSfcModule } from "./helpers/loadSfc.mjs";

test("Pinterest *.pinimg.com URLs are marked CORS-blocked direct & whitelisted for extension", () => {
  const imgUrl = "https://i.pinimg.com/originals/aa/bb/cc/aabbcc.png";
  const vidUrl = "https://v1.pinimg.com/videos/mc/720p/aa/bb/cc/highres.mp4";

  for (const url of [imgUrl, vidUrl]) {
    assert.equal(isCorsBlockedDirectUrl(url), true);
    assert.equal(isWhitelistedMediaUrl(url).allowed, true);

    const traits = inspectDirectFileExtensionTraits({
      routes: [url],
      source: { access: "direct" },
    });
    assert.equal(traits.corsBlockedDirect, true);
    assert.equal(traits.whitelistedForExtension, true);
    assert.equal(traits.requiresRefererOrBlockedFetch, false);
    assert.equal(traits.wantsProactiveExtensionDirect, true);

    const withExt = resolveExecutionPlan(
      {
        deliveryKind: "file",
        whitelistedForExtension: traits.whitelistedForExtension,
        corsBlockedDirect: traits.corsBlockedDirect,
        requiresRefererOrBlockedFetch: traits.requiresRefererOrBlockedFetch,
      },
      {
        extensionConnected: true,
        extensionVersion: "4.5.2",
        extensionCapabilities: ["direct_download"],
      },
    );
    assert.equal(withExt.channel, "extension_direct");
    assert.equal(withExt.canDownload, true);
  }
});

test("downloadAllMedia guards multi-image CORS-blocked Story Pins: delegates with extension, warns without extension", async () => {
  const makeItems = () => [
    {
      id: "image-1",
      type: "image",
      variants: [
        {
          id: "orig-1",
          delivery: {
            kind: "file",
            sources: [{ url: "https://i.pinimg.com/originals/11/11/p1.jpg", access: "direct" }],
          },
        },
      ],
      default: { variant_id: "orig-1", url: "https://i.pinimg.com/originals/11/11/p1.jpg" },
    },
    {
      id: "image-2",
      type: "image",
      variants: [
        {
          id: "orig-2",
          delivery: {
            kind: "file",
            sources: [{ url: "https://i.pinimg.com/originals/22/22/p2.jpg", access: "direct" }],
          },
        },
      ],
      default: { variant_id: "orig-2", url: "https://i.pinimg.com/originals/22/22/p2.jpg" },
    },
  ];

  // Case 1: No extension -> warns user with generic media copy, triggers extension guide, and never invokes JSZip archiveItems.
  {
    const toasts = [];
    let archiveCalled = 0;
    let enqueueCalled = 0;
    let requireExtCalled = 0;
    const actions = createPublicDownloadActions({
      videoStore: { resultData: { items: makeItems() } },
      showToast: (msg, type) => toasts.push({ msg, type }),
      selection: { selectionFor: () => null },
      apiContext: { apiOrigin: "https://snap.dokitool.com" },
      snapshotItem: (item) => ({ item, version: 1 }),
      snapshotTarget: (_snap, item) => ({
        kind: "file",
        url: item.default.url,
        routes: [item.default.url],
        variant: item.variants[0],
        source: item.variants[0].delivery.sources[0],
      }),
      isExtensionConnected: async () => false,
      onRequireExtension: () => {
        requireExtCalled++;
      },
      enqueueItem: async () => {
        enqueueCalled++;
        return true;
      },
      archiveItems: async () => {
        archiveCalled++;
      },
    });
    await actions.downloadAllImages();
    assert.equal(archiveCalled, 0, "must not call JSZip archiveItems on CORS-blocked images");
    assert.equal(enqueueCalled, 0, "must not enqueue individual items when extension is absent");
    assert.equal(requireExtCalled, 1, "must trigger extension guide when extension is absent");
    assert.equal(toasts.length, 1);
    assert.match(toasts[0].msg, /CORS/);
    assert.doesNotMatch(toasts[0].msg, /该站点图片/);
  }

  // Case 2: Extension connected -> delegates each item via enqueueItem with explicit non-ZIP toast.
  {
    const toasts = [];
    let archiveCalled = 0;
    const enqueued = [];
    const actions = createPublicDownloadActions({
      videoStore: { resultData: { items: makeItems() } },
      showToast: (msg, type) => toasts.push({ msg, type }),
      selection: { selectionFor: () => null },
      apiContext: { apiOrigin: "https://snap.dokitool.com" },
      snapshotItem: (item) => ({ item, version: 1 }),
      snapshotTarget: (_snap, item) => ({
        kind: "file",
        url: item.default.url,
        routes: [item.default.url],
        variant: item.variants[0],
        source: item.variants[0].delivery.sources[0],
      }),
      isExtensionConnected: async () => true,
      enqueueItem: async (snap) => {
        enqueued.push(snap.item.id);
        return true;
      },
      archiveItems: async () => {
        archiveCalled++;
      },
    });
    await actions.downloadAllImages();
    assert.equal(archiveCalled, 0, "must skip JSZip when delegating CORS-blocked album to extension");
    assert.deepEqual(enqueued, ["image-1", "image-2"]);
    assert.equal(toasts.length, 1);
    assert.match(toasts[0].msg, /无法打包 ZIP/);
    assert.match(toasts[0].msg, /扩展逐项下载/);
  }
});

test("downloadVideosAsZip guards dual-MP4 Pinterest Story Pin & browser_fetch=blocked batches (0 Web fetch)", async () => {
  const makeDualPinVideos = () => [
    {
      id: "video-1",
      type: "video",
      state: "ready",
      variants: [
        {
          id: "mp4-1",
          metadata: { extension: "mp4", mime_type: "video/mp4", width: 1080, height: 1920, has_audio: true },
          delivery: {
            kind: "file",
            sources: [{ url: "https://v1.pinimg.com/videos/mc/720p/aa/bb/story-1.mp4", access: "direct" }],
          },
        },
      ],
      default: { variant_id: "mp4-1", url: "https://v1.pinimg.com/videos/mc/720p/aa/bb/story-1.mp4" },
    },
    {
      id: "video-2",
      type: "video",
      state: "ready",
      variants: [
        {
          id: "mp4-2",
          metadata: { extension: "mp4", mime_type: "video/mp4", width: 1080, height: 1920, has_audio: true },
          delivery: {
            kind: "file",
            sources: [{ url: "https://v1.pinimg.com/videos/mc/720p/cc/dd/story-2.mp4", access: "direct" }],
          },
        },
      ],
      default: { variant_id: "mp4-2", url: "https://v1.pinimg.com/videos/mc/720p/cc/dd/story-2.mp4" },
    },
  ];

  const origFetch = globalThis.fetch;
  let webFetchCalls = 0;
  globalThis.fetch = async () => {
    webFetchCalls++;
    throw new Error("must not call Web fetch");
  };

  try {
    // 1. Disconnected extension -> 0 Web fetch, 0 archiveItems, 0 enqueueItem, generic toast + extension guide.
    {
      const videos = makeDualPinVideos();
      const toasts = [];
      let archiveCalled = 0;
      let enqueueCalled = 0;
      let requireExtCalled = 0;
      const actions = createPublicDownloadActions({
        videoStore: { resultData: { items: videos } },
        showToast: (msg, type) => toasts.push({ msg, type }),
        selection: { selectionFor: () => null },
        apiContext: { apiOrigin: "https://snap.dokitool.com" },
        snapshotItem: (item) => ({ item, version: 1 }),
        isExtensionConnected: async () => false,
        onRequireExtension: () => {
          requireExtCalled++;
        },
        enqueueItem: async () => {
          enqueueCalled++;
          return true;
        },
        archiveItems: async () => {
          archiveCalled++;
        },
      });
      await actions.downloadVideosAsZip(videos);
      assert.equal(webFetchCalls, 0);
      assert.equal(archiveCalled, 0, "must not invoke JSZip archiveItems on Pinterest multi-video");
      assert.equal(enqueueCalled, 0);
      assert.equal(requireExtCalled, 1);
      assert.equal(toasts.length, 1);
      assert.match(toasts[0].msg, /CORS/);
      assert.doesNotMatch(toasts[0].msg, /该站点图片/);
    }

    // 2. Connected extension -> 0 Web fetch, 0 archiveItems, delegates both MP4s to enqueueItem with explicit non-ZIP toast.
    {
      const videos = makeDualPinVideos();
      const toasts = [];
      let archiveCalled = 0;
      const enqueued = [];
      const actions = createPublicDownloadActions({
        videoStore: { resultData: { items: videos } },
        showToast: (msg, type) => toasts.push({ msg, type }),
        selection: { selectionFor: () => null },
        apiContext: { apiOrigin: "https://snap.dokitool.com" },
        snapshotItem: (item) => ({ item, version: 1 }),
        isExtensionConnected: async () => true,
        enqueueItem: async (snap) => {
          enqueued.push(snap.item.id);
          return true;
        },
        archiveItems: async () => {
          archiveCalled++;
        },
      });
      await actions.downloadVideosAsZip(videos);
      assert.equal(webFetchCalls, 0);
      assert.equal(archiveCalled, 0);
      assert.deepEqual(enqueued, ["video-1", "video-2"]);
      assert.equal(toasts.length, 1);
      assert.match(toasts[0].msg, /无法打包 ZIP/);
      assert.match(toasts[0].msg, /扩展逐项下载/);
    }

    // 3. Normal non-CORS dual videos still use archiveItems.
    {
      const normalVideos = [
        {
          id: "v-a",
          type: "video",
          state: "ready",
          variants: [{ id: "main", delivery: { kind: "file", sources: [{ url: "https://media.example.test/a.mp4", access: "direct" }] } }],
          default: { variant_id: "main", url: "https://media.example.test/a.mp4" },
        },
        {
          id: "v-b",
          type: "video",
          state: "ready",
          variants: [{ id: "main", delivery: { kind: "file", sources: [{ url: "https://media.example.test/b.mp4", access: "direct" }] } }],
          default: { variant_id: "main", url: "https://media.example.test/b.mp4" },
        },
      ];
      let archiveCalled = 0;
      const actions = createPublicDownloadActions({
        videoStore: { resultData: { items: normalVideos } },
        showToast: () => {},
        selection: { selectionFor: () => null },
        apiContext: { apiOrigin: "https://snap.dokitool.com" },
        snapshotItem: (item) => ({ item, version: 1 }),
        isExtensionConnected: async () => false,
        enqueueItem: async () => true,
        archiveItems: async () => {
          archiveCalled++;
        },
      });
      await actions.downloadVideosAsZip(normalVideos);
      assert.equal(archiveCalled, 1, "ordinary non-CORS multi-video must still use archiveItems");
    }
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("ResultSection hides batch ZIP button for CORS-blocked dual-MP4 Story Pin and browser_fetch=blocked multi-video", async () => {
  const { useVideoSelection } = await loadSfcModule(
    new URL("../src/composables/useVideoSelection.ts", import.meta.url),
    { modules: { "../services/apiConfig": { apiConfig: { baseUrl: "" } } } },
  );
  const ResultSection = await loadSfc(
    new URL("../src/components/ResultSection.vue", import.meta.url),
    {
      modules: {
        "../services/apiConfig": { apiConfig: { baseUrl: "" } },
        "./AppIcon.vue": { default: { render: (_, { attrs }) => h("i", attrs) } },
        "./VideoPlaylist.vue": { default: { render: () => h("div", { class: "test-playlist" }) } },
      },
    },
  );

  const renderForData = async (resultData) => {
    const videoStore = reactive({ resultData });
    const selection = useVideoSelection({ videoStore });
    selection.reset();
    const app = createSSRApp({
      render: () =>
        h(ResultSection, {
          resultData,
          resultVersion: 1,
          locale: "zh-CN",
          selection,
          isDownloading: false,
          resolvingIds: new Set(),
          formatNumber: (n) => String(n),
          formatDuration: (ms) => `${Math.round(ms / 1000)}s`,
          extensionState: { connected: false, version: "", capabilities: [] },
        }),
    });
    return renderToString(app);
  };

  // 1. Pinterest dual-MP4 Story Pin -> hides 全部打包ZIP, keeps 全部下载
  const pinHtml = await renderForData({
    platform: "pinterest",
    title: "Story Pin Dual Video",
    source_url: "https://www.pinterest.com/pin/858146903966145191/",
    default_item_id: "video-1",
    items: [
      {
        id: "video-1",
        index: 1,
        type: "video",
        state: "ready",
        variants: [{ id: "v1", metadata: { extension: "mp4", mime_type: "video/mp4", width: 1080, height: 1920, has_audio: true }, delivery: { kind: "file", sources: [{ url: "https://v1.pinimg.com/videos/mc/720p/1.mp4", access: "direct" }] } }],
        default: { variant_id: "v1", url: "https://v1.pinimg.com/videos/mc/720p/1.mp4" },
      },
      {
        id: "video-2",
        index: 2,
        type: "video",
        state: "ready",
        variants: [{ id: "v2", metadata: { extension: "mp4", mime_type: "video/mp4", width: 1080, height: 1920, has_audio: true }, delivery: { kind: "file", sources: [{ url: "https://v1.pinimg.com/videos/mc/720p/2.mp4", access: "direct" }] } }],
        default: { variant_id: "v2", url: "https://v1.pinimg.com/videos/mc/720p/2.mp4" },
      },
    ],
  });
  assert.doesNotMatch(pinHtml, /打包ZIP/, "CORS-blocked Pinterest multi-video must hide batch ZIP button");
  assert.match(pinHtml, /下载全部/, "adjacent batch download button must remain visible");

  // 2. Generic browser_fetch=blocked dual-MP4 -> also hides 全部打包ZIP
  const blockedHtml = await renderForData({
    platform: "tiktok",
    title: "Blocked Multi Video",
    source_url: "https://www.tiktok.com/@i/video/7345678901234567890",
    default_item_id: "v-1",
    items: [
      {
        id: "v-1",
        index: 1,
        type: "video",
        state: "ready",
        variants: [{ id: "m1", metadata: { extension: "mp4", mime_type: "video/mp4", width: 1080, height: 1920, has_audio: true }, delivery: { kind: "file", sources: [{ url: "https://v16.tiktokcdn.com/1.mp4", access: "direct", browser_fetch: "blocked" }] } }],
        default: { variant_id: "m1", url: "https://v16.tiktokcdn.com/1.mp4" },
      },
      {
        id: "v-2",
        index: 2,
        type: "video",
        state: "ready",
        variants: [{ id: "m2", metadata: { extension: "mp4", mime_type: "video/mp4", width: 1080, height: 1920, has_audio: true }, delivery: { kind: "file", sources: [{ url: "https://v16.tiktokcdn.com/2.mp4", access: "direct", browser_fetch: "blocked" }] } }],
        default: { variant_id: "m2", url: "https://v16.tiktokcdn.com/2.mp4" },
      },
    ],
  });
  assert.doesNotMatch(blockedHtml, /打包ZIP/, "browser_fetch=blocked multi-video must hide batch ZIP button");

  // 3. Ordinary non-CORS dual-MP4 -> retains 全部打包ZIP button
  const normalHtml = await renderForData({
    platform: "douyin",
    title: "Normal Multi Video",
    source_url: "https://www.douyin.com/video/123",
    default_item_id: "n-1",
    items: [
      {
        id: "n-1",
        index: 1,
        type: "video",
        state: "ready",
        variants: [{ id: "m1", metadata: { extension: "mp4", mime_type: "video/mp4", width: 1080, height: 1920, has_audio: true }, delivery: { kind: "file", sources: [{ url: "https://media.example.test/1.mp4", access: "direct" }] } }],
        default: { variant_id: "m1", url: "https://media.example.test/1.mp4" },
      },
      {
        id: "n-2",
        index: 2,
        type: "video",
        state: "ready",
        variants: [{ id: "m2", metadata: { extension: "mp4", mime_type: "video/mp4", width: 1080, height: 1920, has_audio: true }, delivery: { kind: "file", sources: [{ url: "https://media.example.test/2.mp4", access: "direct" }] } }],
        default: { variant_id: "m2", url: "https://media.example.test/2.mp4" },
      },
    ],
  });
  assert.match(normalHtml, /全部打包ZIP/, "ordinary non-CORS multi-video must keep batch ZIP button");
});
