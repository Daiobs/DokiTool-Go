import test from "node:test";
import assert from "node:assert/strict";
import {
  isCorsBlockedDirectUrl,
  inspectDirectFileExtensionTraits,
} from "../src/core/media/index.ts";
import { resolveExecutionPlan } from "../src/core/capabilityHub.ts";
import { isWhitelistedMediaUrl } from "../src/extension/hostWhitelist.ts";
import { createPublicDownloadActions } from "../src/composables/download/archive.ts";

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

  // Case 1: No extension -> warns user and never invokes JSZip archiveItems.
  {
    const toasts = [];
    let archiveCalled = 0;
    let enqueueCalled = 0;
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
    assert.equal(toasts.length, 1);
    assert.match(toasts[0].msg, /CORS/);
  }

  // Case 2: Extension connected -> delegates each item via enqueueItem instead of JSZip.
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
    assert.equal(toasts.length, 0);
  }
});
