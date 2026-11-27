import test, { before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import JSZip from "jszip";
import * as mediabunny from "mediabunny";
import {
  FRONTEND_DIR,
  REPO_ROOT_DIR,
  loadExtensionFlowModules,
  createMockWebLocks,
  createMockOpfs,
  createTrackedUrlApi,
  createMockMv3Environment,
  createSyntheticMp4MuxStreams,
  loadSidePanelSfc,
  mountSfcTree,
  createSyntheticDashTrackBuffers,
  buildSampleBilibiliDashMedia,
  sha256Hex,
  makeDeterministicPayload,
  parseTestRangeHeader,
  padMp4WithFreeBox,
  makeTestOpfsSink,
  createOwnerStatsFixture,
} from "./helpers/extensionDownloadFlowHarness.mjs";

let protocol;
let storage;
let youtubeBridgeMod;
let dashMuxSpecMod;
let opfsStreamTransferMod;
let dashMuxDownloadMod;
let dashMuxEngineMod;
let extensionDownloadMod;
let uiTargetHelpersMod;
let targetSpecBuilderMod;
let specRefresherMod;
let offscreenMod;
let backgroundMod;
let mediaContractMod;

before(async () => {
  ({
    protocol,
    storage,
    youtubeBridgeMod,
    dashMuxSpecMod,
    opfsStreamTransferMod,
    dashMuxDownloadMod,
    dashMuxEngineMod,
    extensionDownloadMod,
    uiTargetHelpersMod,
    targetSpecBuilderMod,
    specRefresherMod,
    offscreenMod,
    backgroundMod,
    mediaContractMod,
  } = await loadExtensionFlowModules());
});

beforeEach(() => {
  storage.resetInMemoryExtensionStorage();
});

test("SidePanel Theme: storage defaults, persistence, migration fallback, zero-flash cache helper, and Header/Settings UI", async () => {
  const localArea = storage.createMemoryStorageArea();
  const extStorage = storage.createExtensionStorage({ local: localArea });

  // 1) Default theme is "system"
  assert.equal(storage.DEFAULT_EXTENSION_SETTINGS.theme, "system");
  const initial = await extStorage.getSettings();
  assert.equal(initial.theme, "system");

  // 2) Persist light -> dark -> system via updateSettings
  for (const mode of ["light", "dark", "system"]) {
    const saved = await extStorage.updateSettings({ theme: mode });
    assert.equal(saved.theme, mode);
    const reloaded = await extStorage.getSettings();
    assert.equal(reloaded.theme, mode);
  }

  // 3) Seamless migration: missing or corrupt stored theme falls back to "system"
  //    without losing existing bearerToken, apiBaseUrl, subfolderPrefix, or autoFollowTab!
  await localArea.set({
    [storage.STORAGE_KEYS.SETTINGS]: {
      apiBaseUrl: "https://api.example.com",
      bearerToken: "doki_existing_token_999",
      subfolderPrefix: "MyClips",
      batchSaveMode: "zip",
      qualityPreference: "1080p",
      autoFollowTab: true,
      autoFollowExplicitlySet: true,
    },
  });
  const migratedMissing = await extStorage.getSettings();
  assert.equal(migratedMissing.theme, "system");
  assert.equal(migratedMissing.bearerToken, "doki_existing_token_999");
  assert.equal(migratedMissing.apiBaseUrl, "https://api.example.com");
  assert.equal(migratedMissing.subfolderPrefix, "MyClips");
  assert.equal(migratedMissing.batchSaveMode, "zip");
  assert.equal(migratedMissing.qualityPreference, "1080p");
  assert.equal(migratedMissing.autoFollowTab, true);

  await localArea.set({
    [storage.STORAGE_KEYS.SETTINGS]: {
      apiBaseUrl: "https://api.example.com",
      bearerToken: "doki_existing_token_999",
      theme: "neon-corrupt",
    },
  });
  const migratedCorrupt = await extStorage.getSettings();
  assert.equal(migratedCorrupt.theme, "system");
  assert.equal(migratedCorrupt.bearerToken, "doki_existing_token_999");
  assert.equal(migratedCorrupt.apiBaseUrl, "https://api.example.com");

  const sanitizedPatch = await extStorage.updateSettings({ theme: "invalid-mode" });
  assert.equal(sanitizedPatch.theme, "system");
  assert.equal(sanitizedPatch.bearerToken, "doki_existing_token_999");

  // 4) Zero-flash HTML & MV3 CSP contract: sidepanel.html has no hardcoded dark class and zero inline <script>
  const sidepanelHtml = readFileSync(
    join(FRONTEND_DIR, "src", "extension", "sidepanel.html"),
    "utf8",
  );
  assert.match(sidepanelHtml, /<html lang="zh-CN">/);
  assert.equal(sidepanelHtml.includes('class="dark"'), false);
  assert.equal(/<script\b(?![^>]*\bsrc\s*=)[^>]*>/i.test(sidepanelHtml), false);

  // 5) applyExtensionTheme / applyCachedExtensionTheme / getNextExtensionTheme
  const fakeStorage = new Map();
  const origLocalStorage = globalThis.localStorage;
  const origDocument = globalThis.document;
  const fakeRoot = { dataset: {} };
  globalThis.localStorage = {
    getItem: (k) => (fakeStorage.has(k) ? fakeStorage.get(k) : null),
    setItem: (k, v) => {
      fakeStorage.set(k, String(v));
    },
    removeItem: (k) => fakeStorage.delete(k),
  };
  globalThis.document = { documentElement: fakeRoot };

  try {
    assert.equal(uiTargetHelpersMod.getNextExtensionTheme("system"), "light");
    assert.equal(uiTargetHelpersMod.getNextExtensionTheme("light"), "dark");
    assert.equal(uiTargetHelpersMod.getNextExtensionTheme("dark"), "system");

    uiTargetHelpersMod.applyExtensionTheme("light");
    assert.equal(fakeRoot.dataset.theme, "light");
    assert.equal(
      fakeStorage.get(uiTargetHelpersMod.EXTENSION_THEME_CACHE_KEY),
      "light",
    );

    uiTargetHelpersMod.applyExtensionTheme("dark");
    assert.equal(fakeRoot.dataset.theme, "dark");
    assert.equal(
      fakeStorage.get(uiTargetHelpersMod.EXTENSION_THEME_CACHE_KEY),
      "dark",
    );

    // Preview with persistCache:false does NOT overwrite localStorage cache
    uiTargetHelpersMod.applyExtensionTheme("light", { persistCache: false });
    assert.equal(fakeRoot.dataset.theme, "light");
    assert.equal(
      fakeStorage.get(uiTargetHelpersMod.EXTENSION_THEME_CACHE_KEY),
      "dark",
    );

    // applyCachedExtensionTheme restores cached "dark" synchronously on boot
    delete fakeRoot.dataset.theme;
    const restored = uiTargetHelpersMod.applyCachedExtensionTheme();
    assert.equal(restored, "dark");
    assert.equal(fakeRoot.dataset.theme, "dark");

    // "system" deletes data-theme attribute so live prefers-color-scheme takes over
    uiTargetHelpersMod.applyExtensionTheme("system");
    assert.equal("theme" in fakeRoot.dataset, false);
    assert.equal(
      fakeStorage.get(uiTargetHelpersMod.EXTENSION_THEME_CACHE_KEY),
      "system",
    );

    // 6) SidePanelHeader quick theme cycle button tooltips & emit
    const SidePanelHeader = await loadSidePanelSfc(
      "../src/extension/components/SidePanelHeader.vue",
    );
    let cycleEmits = 0;
    const headerView = mountSfcTree(
      SidePanelHeader,
      {
        settings: { ...storage.DEFAULT_EXTENSION_SETTINGS, theme: "system" },
        connection: null,
        mode: "single",
        batchUrlCount: 0,
      },
      {
        onCycleTheme: () => {
          cycleEmits += 1;
        },
      },
    );
    try {
      await headerView.flush();
      const findThemeBtn = () =>
        headerView.findAll(
          (node) =>
            node.type === "button" &&
            typeof node.props.class === "string" &&
            node.props.class.includes("sp-theme-btn"),
        )[0];

      assert.equal(
        findThemeBtn()?.props.title,
        "主题：跟随系统（点击切换为浅色）",
      );
      await headerView.fire(findThemeBtn(), "onClick");
      assert.equal(cycleEmits, 1);

      headerView.propsRef.value = {
        ...headerView.propsRef.value,
        settings: { ...storage.DEFAULT_EXTENSION_SETTINGS, theme: "light" },
      };
      await headerView.flush();
      assert.equal(findThemeBtn()?.props.title, "主题：浅色（点击切换为深色）");

      headerView.propsRef.value = {
        ...headerView.propsRef.value,
        settings: { ...storage.DEFAULT_EXTENSION_SETTINGS, theme: "dark" },
      };
      await headerView.flush();
      assert.equal(
        findThemeBtn()?.props.title,
        "主题：深色（点击切换为跟随系统）",
      );
    } finally {
      headerView.unmount();
    }

    // 7) SidePanelSettings 3-way segmented control: live preview, restore on cancel, persist on save
    const SidePanelSettings = await loadSidePanelSfc(
      "../src/extension/components/SidePanelSettings.vue",
    );
    const savedPatches = [];
    const savedEvents = [];
    const origChrome = globalThis.chrome;
    globalThis.chrome = {
      runtime: {
        sendMessage(req, cb) {
          if (req?.type === "UPDATE_SETTINGS") {
            savedPatches.push(req.patch);
            cb?.({
              ok: true,
              data: {
                settings: {
                  ...storage.DEFAULT_EXTENSION_SETTINGS,
                  ...req.patch,
                },
              },
            });
            return;
          }
          cb?.({
            ok: true,
            data: {
              ok: true,
              status: 200,
              authMode: "anonymous",
              platformCount: 14,
              message: "200 OK",
              checkedAt: Date.now(),
            },
          });
        },
      },
    };

    uiTargetHelpersMod.applyExtensionTheme("dark");
    const settingsView = mountSfcTree(
      SidePanelSettings,
      {
        open: true,
        settings: { ...storage.DEFAULT_EXTENSION_SETTINGS, theme: "dark" },
        connection: null,
      },
      {
        onSaved: (next) => savedEvents.push(next),
        onClose: () => {
          settingsView.propsRef.value = {
            ...settingsView.propsRef.value,
            open: false,
          };
        },
      },
    );
    try {
      await settingsView.flush();
      assert.match(settingsView.textOf(), /外观主题/);
      const lightChoice = settingsView.findAll(
        (node) =>
          node.type === "button" &&
          typeof node.props.class === "string" &&
          node.props.class.includes("sp-theme-choice") &&
          settingsView.textOf(node).trim() === "浅色",
      )[0];
      assert.ok(lightChoice, "renders 浅色 theme option");

      // Click 浅色 -> live previews light theme without persisting cache yet
      await settingsView.fire(lightChoice, "onClick");
      assert.equal(fakeRoot.dataset.theme, "light");
      assert.equal(
        fakeStorage.get(uiTargetHelpersMod.EXTENSION_THEME_CACHE_KEY),
        "dark",
      );

      // Click 取消 -> closes and restores saved "dark" theme
      const cancelBtn = settingsView.findAll(
        (node) =>
          node.type === "button" && settingsView.textOf(node).trim() === "取消",
      )[0];
      await settingsView.fire(cancelBtn, "onClick");
      assert.equal(fakeRoot.dataset.theme, "dark");

      // Reopen, select 浅色, click 保存设置 -> sends UPDATE_SETTINGS { theme: "light" } and persists cache
      settingsView.propsRef.value = {
        ...settingsView.propsRef.value,
        open: true,
      };
      await settingsView.flush();
      const lightChoice2 = settingsView.findAll(
        (node) =>
          node.type === "button" &&
          typeof node.props.class === "string" &&
          node.props.class.includes("sp-theme-choice") &&
          settingsView.textOf(node).trim() === "浅色",
      )[0];
      await settingsView.fire(lightChoice2, "onClick");
      const saveBtn = settingsView.findAll(
        (node) =>
          node.type === "button" &&
          settingsView.textOf(node).trim() === "保存设置",
      )[0];
      await settingsView.fire(saveBtn, "onClick");
      await new Promise((r) => setTimeout(r, 15));
      assert.equal(savedPatches.length, 1);
      assert.equal(savedPatches[0].theme, "light");
      assert.equal(savedEvents[0]?.theme, "light");
      assert.equal(fakeRoot.dataset.theme, "light");
      assert.equal(
        fakeStorage.get(uiTargetHelpersMod.EXTENSION_THEME_CACHE_KEY),
        "light",
      );
    } finally {
      settingsView.unmount();
      globalThis.chrome = origChrome;
    }
  } finally {
    globalThis.localStorage = origLocalStorage;
    globalThis.document = origDocument;
  }
});

// ============================================================================
// Dynamic Action Tooltip (chrome.action.setTitle) & Percentage Badge Tests
// ============================================================================

test("computeActionIndicator: pure state computation for single, multi-task aggregate, and terminal outcomes", () => {
  const mkTask = (overrides) => ({
    taskId: "t1",
    title: "测试视频标题",
    filename: "test.mp4",
    platform: "bilibili",
    status: "downloading",
    statusText: "下载中",
    percent: 0,
    loaded: 0,
    total: 0,
    speed: 0,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  });

  // Idle / clear
  const idle = backgroundMod.computeActionIndicator([]);
  assert.deepEqual(idle, {
    badgeText: "",
    title: backgroundMod.DEFAULT_ACTION_TITLE,
    shouldScheduleClear: false,
  });

  // Single task: queued / parsing / 0% downloading -> badge "1"
  const parsing = backgroundMod.computeActionIndicator([
    mkTask({ status: "parsing", percent: 0, title: "抖音极速解析任务" }),
  ]);
  assert.equal(parsing.badgeText, "1");
  assert.equal(parsing.badgeColor, "#6366f1");
  assert.equal(parsing.title, "DokiTool · 解析中\n抖音极速解析任务");
  assert.equal(parsing.shouldScheduleClear, false);

  // Single task: downloading 64% at 4.2 MB/s
  const downloading = backgroundMod.computeActionIndicator([
    mkTask({
      status: "downloading",
      percent: 64,
      speed: 4_200_000,
      title: "超清晰4K航拍风景纪录片",
    }),
  ]);
  assert.equal(downloading.badgeText, "64%");
  assert.equal(downloading.badgeColor, "#6366f1");
  assert.equal(
    downloading.title,
    "DokiTool · 下载中 64% (4.2 MB/s)\n超清晰4K航拍风景纪录片",
  );

  // Single task: KB/s speed formatting, 100% clamped to 99%, long title truncated <= 28 chars
  const longTitle =
    "这是一个非常非常非常非常非常非常非常非常长的视频标题超过二十八个字符";
  const savingLong = backgroundMod.computeActionIndicator([
    mkTask({
      status: "saving",
      percent: 100,
      speed: 680_000,
      title: longTitle,
    }),
  ]);
  assert.equal(savingLong.badgeText, "99%");
  assert.match(savingLong.title, /^DokiTool · 保存中 99% \(680 KB\/s\)\n/);
  const secondLine = savingLong.title.split("\n")[1];
  assert.ok(Array.from(secondLine).length <= 28, "truncated title <= 28 chars");
  assert.ok(secondLine.endsWith("…"));

  // Multi-task byte-weighted aggregate (all active tasks have total > 0)
  // Task 1: 10 MB / 100 MB (10%), speed 2 MB/s; Task 2: 200 MB / 300 MB (67%), speed 3 MB/s
  // Byte-weighted: 210 / 400 = 52.5% -> 53%, total speed 5.0 MB/s
  const multiByteWeighted = backgroundMod.computeActionIndicator([
    mkTask({
      taskId: "t1",
      title: "第一集",
      status: "downloading",
      percent: 10,
      loaded: 10_000_000,
      total: 100_000_000,
      speed: 2_000_000,
    }),
    mkTask({
      taskId: "t2",
      title: "第二集",
      status: "downloading",
      percent: 67,
      loaded: 200_000_000,
      total: 300_000_000,
      speed: 3_000_000,
    }),
  ]);
  assert.equal(multiByteWeighted.badgeText, "53%");
  assert.equal(multiByteWeighted.badgeColor, "#6366f1");
  assert.equal(
    multiByteWeighted.title,
    "DokiTool · 后台下载中 2 个任务 · 总进度 53% (5.0 MB/s)\n当前：第一集 (10%)",
  );

  // Multi-task arithmetic mean fallback when any active task lacks total > 0
  const multiMean = backgroundMod.computeActionIndicator([
    mkTask({
      taskId: "t1",
      title: "分片流A",
      status: "downloading",
      percent: 20,
      total: 0,
      speed: 500_000,
    }),
    mkTask({
      taskId: "t2",
      title: "合流B",
      status: "muxing",
      percent: 60,
      total: 1000,
      loaded: 600,
      speed: 0,
    }),
  ]);
  assert.equal(multiMean.badgeText, "40%");
  assert.equal(
    multiMean.title,
    "DokiTool · 后台下载中 2 个任务 · 总进度 40% (500 KB/s)\n当前：分片流A (20%)",
  );

  // Multi-task indeterminate 0% shows active count
  const multiZero = backgroundMod.computeActionIndicator([
    mkTask({ taskId: "t1", status: "queued", percent: 0, total: 0 }),
    mkTask({ taskId: "t2", status: "parsing", percent: 0, total: 0 }),
  ]);
  assert.equal(multiZero.badgeText, "2");

  // Terminal completed / failed / clear
  const done = backgroundMod.computeActionIndicator(
    [mkTask({ status: "completed", percent: 100 })],
    "completed",
  );
  assert.deepEqual(done, {
    badgeText: "✓",
    badgeColor: "#10b981",
    title: "DokiTool · 后台下载已完成（点击打开侧边栏查看）",
    shouldScheduleClear: true,
  });

  const failed = backgroundMod.computeActionIndicator(
    [mkTask({ status: "failed" })],
    "failed",
  );
  assert.deepEqual(failed, {
    badgeText: "!",
    badgeColor: "#ef4444",
    title: "DokiTool · 有后台任务失败（点击打开侧边栏查看或重试）",
    shouldScheduleClear: false,
  });

  const cleared = backgroundMod.computeActionIndicator([], "clear");
  assert.deepEqual(cleared, {
    badgeText: "",
    title: backgroundMod.DEFAULT_ACTION_TITLE,
    shouldScheduleClear: false,
  });
});

test("Background Controller lifecycle: dynamic setBadgeText & setTitle across parsing -> downloading -> muxing -> saving -> completed -> idle reset, multi-task, deduplication, and failed", async () => {
  const env = createMockMv3Environment({ autoCompleteDownloads: false });

  // Gate parse API response so we can observe the real "parsing" badge ("1") + tooltip before download starts
  let releaseParseGate = () => {};
  const parseGate = new Promise((r) => {
    releaseParseGate = r;
  });
  let parseStarted = false;
  let startedTaskId = "";

  const mockFetch = async (url) => {
    if (String(url).includes("/api/parse")) {
      parseStarted = true;
      await parseGate;
      return new Response(
        JSON.stringify({
          schema_version: "1.0",
          code: "OK",
          data: {
            platform: "bilibili",
            content_id: "BV1actionTest",
            title: "B站4K测试视频",
            source_url: "https://www.bilibili.com/video/BV1actionTest",
            items: [
              {
                id: "v1",
                type: "video",
                title: "B站4K测试视频",
                variants: [
                  {
                    id: "var-4k",
                    label: "4K",
                    metadata: {
                      extension: "mp4",
                      width: 3840,
                      height: 2160,
                      has_audio: true,
                    },
                    delivery: {
                      kind: "file",
                      sources: [
                        {
                          url: "https://upos-sz-mirrorcos.bilivideo.com/4k.mp4",
                          size_bytes: 100_000_000,
                        },
                      ],
                    },
                  },
                ],
                default: {
                  variant_id: "var-4k",
                  url: "https://upos-sz-mirrorcos.bilivideo.com/4k.mp4",
                },
              },
            ],
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    throw new Error(`Unexpected fetch URL: ${url}`);
  };

  // Stub offscreen message responder so we drive exact OFFSCREEN_TASK_PROGRESS / HANDOFF_BLOB_DOWNLOAD ticks deterministically
  env.chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === "OFFSCREEN_START_TASK") {
      startedTaskId = msg.taskId;
      sendResponse({ ok: true, data: { accepted: true } });
      return true;
    }
    if (msg?.type === "RELEASE_BLOB") {
      sendResponse({ ok: true, data: { released: true } });
      return true;
    }
    return false;
  });

  const extStorage = storage.createExtensionStorage();
  const bg = backgroundMod.createBackgroundController({
    chrome: env.chrome,
    storage: extStorage,
    fetchImpl: mockFetch,
    badgeSuccessDurationMs: 45,
    badgeProgressThrottleMs: 0,
  });

  try {
    // 1) init() sets idle badge "" & DEFAULT_ACTION_TITLE
    await bg.init();
    assert.equal(
      env.badgeHistory.filter((e) => e.kind === "text").at(-1)?.text,
      "",
    );
    assert.equal(
      env.badgeHistory.filter((e) => e.kind === "title").at(-1)?.title,
      backgroundMod.DEFAULT_ACTION_TITLE,
    );

    // 2) Single-task full lifecycle: parsing ("1") -> downloading ("42%" + speed) -> dedup -> muxing ("85%") -> saving ("99%") -> completed ("✓") -> idle reset
    env.badgeHistory.length = 0;
    env.emitContextMenuClick(
      {
        menuItemId: protocol.CONTEXT_MENU_QUICK_DOWNLOAD_ID,
        linkUrl: "https://www.bilibili.com/video/BV1actionTest",
      },
      { id: 1, windowId: 10 },
    );

    for (let i = 0; i < 50 && !parseStarted; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    assert.equal(parseStarted, true, "quick-download entered parsing phase");
    assert.equal(
      env.badgeHistory.filter((e) => e.kind === "text").at(-1)?.text,
      "1",
      "parsing phase displays badge '1'",
    );
    assert.match(
      env.badgeHistory.filter((e) => e.kind === "title").at(-1)?.title ?? "",
      /^DokiTool · 解析中\n/,
      "parsing phase displays 解析中 tooltip",
    );

    // Release parse gate -> task starts downloading in offscreen
    releaseParseGate();
    for (let i = 0; i < 50 && !startedTaskId; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    const taskId = startedTaskId;
    assert.ok(taskId, "offscreen task started");

    // Progress: downloading 42% at 4.2 MB/s
    await env.chrome.runtime.sendMessage({
      type: "OFFSCREEN_TASK_PROGRESS",
      taskId,
      status: "downloading",
      statusText: "正在下载...",
      percent: 42,
      loaded: 42_000_000,
      total: 100_000_000,
      speed: 4_200_000,
    });
    assert.equal(
      env.badgeHistory.filter((e) => e.kind === "text").at(-1)?.text,
      "42%",
    );
    assert.equal(
      env.badgeHistory.filter((e) => e.kind === "title").at(-1)?.title,
      "DokiTool · 下载中 42% (4.2 MB/s)\nB站4K测试视频",
    );

    // Identical rapid progress tick MUST NOT spam setBadgeText / setBadgeBackgroundColor / setTitle!
    const historyLenBeforeDup = env.badgeHistory.length;
    await env.chrome.runtime.sendMessage({
      type: "OFFSCREEN_TASK_PROGRESS",
      taskId,
      status: "downloading",
      statusText: "正在下载...",
      percent: 42,
      loaded: 42_050_000,
      total: 100_000_000,
      speed: 4_200_000,
    });
    assert.equal(
      env.badgeHistory.length,
      historyLenBeforeDup,
      "Identical indicator values must be deduplicated without spamming Chrome IPC",
    );

    // Progress: muxing 85%
    await env.chrome.runtime.sendMessage({
      type: "OFFSCREEN_TASK_PROGRESS",
      taskId,
      status: "muxing",
      statusText: "正在无损合流...",
      percent: 85,
      loaded: 85_000_000,
      total: 100_000_000,
      speed: 0,
    });
    assert.equal(
      env.badgeHistory.filter((e) => e.kind === "text").at(-1)?.text,
      "85%",
    );
    assert.equal(
      env.badgeHistory.filter((e) => e.kind === "title").at(-1)?.title,
      "DokiTool · 合流中 85%\nB站4K测试视频",
    );

    // Handoff -> saving 99%
    const handoff = await env.chrome.runtime.sendMessage({
      type: "HANDOFF_BLOB_DOWNLOAD",
      taskId,
      blobUrl: "blob:chrome-extension://test/1",
      filename: "B站4K测试视频.mp4",
      sizeBytes: 100_000_000,
    });
    assert.equal(handoff.ok, true);
    assert.equal(
      env.badgeHistory.filter((e) => e.kind === "text").at(-1)?.text,
      "99%",
    );
    assert.equal(
      env.badgeHistory.filter((e) => e.kind === "title").at(-1)?.title,
      "DokiTool · 保存中 99%\nB站4K测试视频",
    );

    // Complete -> badge "✓", color "#10b981", completed title
    env.emitDownloadChanged({
      id: handoff.data.chromeDownloadId,
      state: { current: "complete" },
    });
    await bg.waitForIdle();
    assert.equal(
      env.badgeHistory.filter((e) => e.kind === "text").at(-1)?.text,
      "✓",
    );
    assert.equal(
      env.badgeHistory.filter((e) => e.kind === "color").at(-1)?.color,
      "#10b981",
    );
    assert.equal(
      env.badgeHistory.filter((e) => e.kind === "title").at(-1)?.title,
      "DokiTool · 后台下载已完成（点击打开侧边栏查看）",
    );

    // After badgeSuccessDurationMs, BOTH badge "" and title DEFAULT_ACTION_TITLE reset!
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(
      env.badgeHistory.filter((e) => e.kind === "text").at(-1)?.text,
      "",
    );
    assert.equal(
      env.badgeHistory.filter((e) => e.kind === "title").at(-1)?.title,
      backgroundMod.DEFAULT_ACTION_TITLE,
    );

    // 3) Multi-task concurrent aggregate percentage & total speed tooltip + failed state
    env.badgeHistory.length = 0;
    const multiEnq = await env.chrome.runtime.sendMessage({
      type: "ENQUEUE_DOWNLOADS",
      items: [
        {
          title: "多任务一",
          platform: "bilibili",
          spec: {
            kind: "direct_file",
            apiOrigin: "https://snap.dokitool.com",
            routes: ["https://upos-sz-mirrorcos.bilivideo.com/a.mp4"],
            filename: "a.mp4",
            sizeBytes: 10_000_000,
          },
        },
        {
          title: "多任务二",
          platform: "bilibili",
          spec: {
            kind: "direct_file",
            apiOrigin: "https://snap.dokitool.com",
            routes: ["https://upos-sz-mirrorcos.bilivideo.com/b.mp4"],
            filename: "b.mp4",
            sizeBytes: 30_000_000,
          },
        },
      ],
    });
    const [m1, m2] = multiEnq.data.taskIds;
    await new Promise((r) => setTimeout(r, 15));

    await env.chrome.runtime.sendMessage({
      type: "OFFSCREEN_TASK_PROGRESS",
      taskId: m1,
      status: "downloading",
      statusText: "正在下载...",
      percent: 50,
      loaded: 5_000_000,
      total: 10_000_000,
      speed: 1_500_000,
    });
    await env.chrome.runtime.sendMessage({
      type: "OFFSCREEN_TASK_PROGRESS",
      taskId: m2,
      status: "downloading",
      statusText: "正在下载...",
      percent: 50,
      loaded: 15_000_000,
      total: 30_000_000,
      speed: 2_500_000,
    });

    // Aggregate: 20MB / 40MB = 50%, total speed 4.0 MB/s
    assert.equal(
      env.badgeHistory.filter((e) => e.kind === "text").at(-1)?.text,
      "50%",
    );
    assert.equal(
      env.badgeHistory.filter((e) => e.kind === "title").at(-1)?.title,
      "DokiTool · 后台下载中 2 个任务 · 总进度 50% (4.0 MB/s)\n当前：多任务一 (50%)",
    );

    // Fail both tasks -> badge "!", color "#ef4444", failed title
    await env.chrome.runtime.sendMessage({
      type: "OFFSCREEN_TASK_ERROR",
      taskId: m1,
      error: "network error 1",
    });
    assert.equal(
      env.badgeHistory.filter((e) => e.kind === "text").at(-1)?.text,
      "50%",
    );

    await env.chrome.runtime.sendMessage({
      type: "OFFSCREEN_TASK_ERROR",
      taskId: m2,
      error: "network error 2",
    });
    assert.equal(
      env.badgeHistory.filter((e) => e.kind === "text").at(-1)?.text,
      "!",
    );
    assert.equal(
      env.badgeHistory.filter((e) => e.kind === "color").at(-1)?.color,
      "#ef4444",
    );
    assert.equal(
      env.badgeHistory.filter((e) => e.kind === "title").at(-1)?.title,
      "DokiTool · 有后台任务失败（点击打开侧边栏查看或重试）",
    );

    // CLEAR_FINISHED_TASKS resets BOTH badge "" and title DEFAULT_ACTION_TITLE
    await env.chrome.runtime.sendMessage({ type: "CLEAR_FINISHED_TASKS" });
    assert.equal(
      env.badgeHistory.filter((e) => e.kind === "text").at(-1)?.text,
      "",
    );
    assert.equal(
      env.badgeHistory.filter((e) => e.kind === "title").at(-1)?.title,
      backgroundMod.DEFAULT_ACTION_TITLE,
    );
  } finally {
    bg.dispose();
  }
});

test("MV3 Weibo relay regression: validateMediaEnvelope & background PARSE_URL/RESOLVE_LAZY_ITEM succeed when location.origin is chrome-extension://", async () => {
  const prevLocationDesc = Object.getOwnPropertyDescriptor(
    globalThis,
    "location",
  );
  Object.defineProperty(globalThis, "location", {
    value: { origin: "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
    configurable: true,
    writable: true,
  });

  const weiboRelayEnvelope = {
    schema_version: "1.0",
    code: "OK",
    data: {
      platform: "weibo",
      content_id: "1034:5339966948180025",
      title: "微博中转测试视频",
      source_url:
        "https://weibo.com/tv/show/1034:5339966948180025?from=old_pc_videoshow",
      generated_at: "2026-11-21T15:00:00Z",
      cover: {
        url: "https://wx4.sinaimg.cn/orj480/test-cover.jpg",
        access: "direct",
      },
      author: {
        name: "测试博主",
        avatar: {
          url: "https://tvax2.sinaimg.cn/crop.0.0.100.100/test-avatar.jpg",
          access: "direct",
        },
      },
      items: [
        {
          id: "video-1",
          type: "video",
          state: "ready",
          cover: {
            url: "/api/media/weibo?ticket=cover-relay-test",
            access: "relay",
          },
          default: {
            variant_id: "mp4_1080p",
            url: "/api/media/weibo?ticket=test",
            access: "relay",
          },
          variants: [
            {
              id: "mp4_1080p",
              label: "1080P",
              delivery: {
                kind: "file",
                sources: [
                  {
                    url: "/api/media/weibo?ticket=test",
                    access: "relay",
                    size_bytes: 1234567,
                  },
                ],
              },
              metadata: {
                width: 1920,
                height: 1080,
                container: "mp4",
                extension: "mp4",
                mime_type: "video/mp4",
              },
            },
          ],
        },
      ],
      attachments: [
        {
          id: "att-1",
          kind: "audio",
          label: "伴音",
          resource: {
            id: "att-res-1",
            role: "audio",
            delivery: {
              kind: "file",
              sources: [
                {
                  url: "/api/media/weibo?ticket=audio-test",
                  access: "relay",
                },
              ],
            },
          },
        },
      ],
    },
  };

  let bg = null;
  try {
    // 1. Without apiOrigin context, chrome-extension:// location.origin must still fail closed
    assert.throws(
      () => mediaContractMod.validateMediaEnvelope(weiboRelayEnvelope),
      /API origin 无效/,
    );

    // 2. With explicit apiOrigin context, validateMediaEnvelope succeeds across variants, default, cover & attachments
    const validated = mediaContractMod.validateMediaEnvelope(
      weiboRelayEnvelope,
      { apiOrigin: "https://snap.dokitool.com" },
    );
    assert.equal(validated.platform, "weibo");
    assert.equal(
      validated.items[0].default?.url,
      "/api/media/weibo?ticket=test",
    );

    // 3. Full background controller PARSE_URL & RESOLVE_ITEM with chrome-extension:// location.origin
    const env = createMockMv3Environment();
    const fetchCalls = [];
    const mockFetch = async (url) => {
      fetchCalls.push(String(url));
      return new Response(JSON.stringify(weiboRelayEnvelope), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    const extStorage = storage.createExtensionStorage();
    bg = backgroundMod.createBackgroundController({
      chrome: env.chrome,
      storage: extStorage,
      fetchImpl: mockFetch,
    });
    await bg.init();

    const parseResp = await env.chrome.runtime.sendMessage({
      type: "PARSE_URL",
      url: "https://weibo.com/tv/show/1034:5339966948180025?from=old_pc_videoshow",
    });
    assert.equal(
      parseResp.ok,
      true,
      `PARSE_URL failed: ${parseResp.error || ""}`,
    );
    assert.equal(parseResp.data.media.platform, "weibo");
    assert.equal(
      parseResp.data.media.items[0].default?.url,
      "/api/media/weibo?ticket=test",
    );

    const resolveResp = await env.chrome.runtime.sendMessage({
      type: "RESOLVE_LAZY_ITEM",
      resolveUrl:
        "/api/resolve?platform=weibo&url=https%3A%2F%2Fweibo.com%2Ftv%2Fshow%2F1034%3A5339966948180025&item=video-1",
    });
    assert.equal(
      resolveResp.ok,
      true,
      `RESOLVE_LAZY_ITEM failed: ${resolveResp.error || ""}`,
    );
    assert.equal(resolveResp.data.media.platform, "weibo");
    assert.equal(fetchCalls.length, 2);
  } finally {
    bg?.dispose();
    if (prevLocationDesc) {
      Object.defineProperty(globalThis, "location", prevLocationDesc);
    } else {
      delete globalThis.location;
    }
  }
});

test("background badge & tooltip: late cancelled callback does not wipe terminal failed '!' or completed '✓' indicators", async () => {
  const env = createMockMv3Environment({ autoCompleteDownloads: false });
  env.chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === "OFFSCREEN_START_TASK") {
      sendResponse({ ok: true, data: { accepted: true } });
      return true;
    }
    if (msg?.type === "OFFSCREEN_CANCEL_TASK") {
      sendResponse({ ok: true, data: { cancelled: true } });
      return true;
    }
    if (msg?.type === "RELEASE_BLOB") {
      sendResponse({ ok: true, data: { released: true } });
      return true;
    }
    return false;
  });
  const extStorage = storage.createExtensionStorage();
  const bg = backgroundMod.createBackgroundController({
    chrome: env.chrome,
    storage: extStorage,
    badgeSuccessDurationMs: 60,
    fetchImpl: async () => new Response("{}", { status: 200 }),
  });

  const lastBadgeText = () =>
    [...env.badgeHistory].reverse().find((e) => e.kind === "text")?.text;
  const lastBadgeTitle = () =>
    [...env.badgeHistory].reverse().find((e) => e.kind === "title")?.title;

  try {
    await bg.init();

    // Case 1: Task 2 cancelled while Task 1 fails -> delayed OFFSCREEN_TASK_ERROR(cancelled) must NOT wipe "!"
    const enq1 = await env.chrome.runtime.sendMessage({
      type: "ENQUEUE_DOWNLOADS",
      items: [
        {
          title: "视频 A",
          platform: "douyin",
          spec: {
            kind: "direct_file",
            apiOrigin: "https://snap.dokitool.com",
            routes: ["https://v26-cold.douyinvod.com/a.mp4"],
            filename: "a.mp4",
            mimeType: "video/mp4",
          },
        },
        {
          title: "视频 B",
          platform: "douyin",
          spec: {
            kind: "direct_file",
            apiOrigin: "https://snap.dokitool.com",
            routes: ["https://v26-cold.douyinvod.com/b.mp4"],
            filename: "b.mp4",
            mimeType: "video/mp4",
          },
        },
      ],
    });
    assert.equal(enq1.ok, true);
    const [taskA, taskB] = enq1.data.taskIds;

    // Cancel Task B first
    const cancelRes = await env.chrome.runtime.sendMessage({
      type: "CANCEL_TASK",
      taskId: taskB,
    });
    assert.equal(cancelRes.ok, true);

    // Task A fails -> badge="!" and failed tooltip
    await env.chrome.runtime.sendMessage({
      type: "OFFSCREEN_TASK_ERROR",
      taskId: taskA,
      error: "CDN 403",
    });
    assert.equal(lastBadgeText(), "!");
    assert.match(lastBadgeTitle() || "", /失败/);

    // Delayed Offscreen cancelled error for Task B arrives -> must NOT wipe "!" or title!
    await env.chrome.runtime.sendMessage({
      type: "OFFSCREEN_TASK_ERROR",
      taskId: taskB,
      error: "已取消",
      cancelled: true,
    });
    assert.equal(lastBadgeText(), "!");
    assert.match(lastBadgeTitle() || "", /失败/);

    // Explicit clear MUST still reset badge & title cleanly
    await env.chrome.runtime.sendMessage({ type: "CLEAR_FINISHED_TASKS" });
    assert.equal(lastBadgeText(), "");
    assert.equal(lastBadgeTitle(), backgroundMod.DEFAULT_ACTION_TITLE);

    // Case 2: Task C completes ("✓") while cancelled Task D sends late OFFSCREEN_TASK_ERROR(cancelled)
    const enq2 = await env.chrome.runtime.sendMessage({
      type: "ENQUEUE_DOWNLOADS",
      items: [
        {
          title: "视频 C",
          platform: "x",
          spec: {
            kind: "direct_file",
            apiOrigin: "https://snap.dokitool.com",
            routes: ["https://video.twimg.com/c.mp4"],
            filename: "c.mp4",
            mimeType: "video/mp4",
          },
        },
        {
          title: "视频 D",
          platform: "x",
          spec: {
            kind: "direct_file",
            apiOrigin: "https://snap.dokitool.com",
            routes: ["https://video.twimg.com/d.mp4"],
            filename: "d.mp4",
            mimeType: "video/mp4",
          },
        },
      ],
    });
    const [taskC, taskD] = enq2.data.taskIds;
    await env.chrome.runtime.sendMessage({ type: "CANCEL_TASK", taskId: taskD });

    const handoff = await env.chrome.runtime.sendMessage({
      type: "HANDOFF_BLOB_DOWNLOAD",
      taskId: taskC,
      blobUrl: "blob:chrome-extension://ext/c",
      filename: "c.mp4",
      mimeType: "video/mp4",
      sizeBytes: 1024,
    });
    assert.equal(handoff.ok, true);
    env.emitDownloadChanged({
      id: handoff.data.chromeDownloadId,
      state: { current: "complete" },
    });
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(lastBadgeText(), "✓");
    assert.match(lastBadgeTitle() || "", /已完成/);

    // Delayed cancel callback for Task D must preserve "✓" and its auto-clear timer
    await env.chrome.runtime.sendMessage({
      type: "OFFSCREEN_TASK_ERROR",
      taskId: taskD,
      error: "已取消",
      cancelled: true,
    });
    assert.equal(lastBadgeText(), "✓");
    assert.match(lastBadgeTitle() || "", /已完成/);

    // Wait for scheduled auto-clear timer to reset cleanly to idle
    await new Promise((r) => setTimeout(r, 90));
    assert.equal(lastBadgeText(), "");
    assert.equal(lastBadgeTitle(), backgroundMod.DEFAULT_ACTION_TITLE);
  } finally {
    bg.dispose();
  }
});


test("[PR-C Round 2] uiTargetHelpers.openMonitorDashboardTab: opens Web ${apiOrigin}/monitor, supports loopback, reuses /monitor or /monitor.html tabs, rejects invalid apiBaseUrl, and never appends query/hash/token", async () => {
  const prevChrome = globalThis.chrome;
  try {
    // 1) Outside Chrome extension runtime -> false
    delete globalThis.chrome;
    assert.equal(await uiTargetHelpersMod.openMonitorDashboardTab(), false);

    // 2) Invalid apiBaseUrl inputs -> false with zero chrome.tabs calls
    const invalidCalls = [];
    globalThis.chrome = {
      tabs: {
        query: async (q) => {
          invalidCalls.push(["query", q]);
          return [];
        },
        update: async (id, props) => {
          invalidCalls.push(["update", id, props]);
        },
        create: async (props) => {
          invalidCalls.push(["create", props]);
        },
      },
    };
    for (const badBase of [
      "   ",
      "http://evil.com",
      "https://192.168.1.1",
      "https://snap.dokitool.com/subpath",
      "https://snap.dokitool.com?token=secret",
      "https://snap.dokitool.com#token=secret",
      "javascript:alert(1)",
      "https://portal.intranet",
    ]) {
      assert.equal(
        await uiTargetHelpersMod.openMonitorDashboardTab(badBase),
        false,
        `expected invalid apiBaseUrl to return false: ${badBase}`,
      );
    }
    assert.equal(invalidCalls.length, 0, "invalid apiBaseUrl must issue zero tabs API calls");

    // 3) Default apiBaseUrl (undefined & "") opens https://snap.dokitool.com/monitor when absent
    const calls = { query: [], update: [], windowUpdate: [], create: [] };
    let existingTabs = [];
    globalThis.chrome = {
      tabs: {
        query: async (q) => {
          calls.query.push(q);
          return existingTabs;
        },
        update: async (id, props) => {
          calls.update.push({ id, props });
        },
        create: async (props) => {
          calls.create.push(props);
        },
      },
      windows: {
        update: async (wid, props) => {
          calls.windowUpdate.push({ wid, props });
        },
      },
    };

    assert.equal(await uiTargetHelpersMod.openMonitorDashboardTab(), true);
    assert.deepEqual(calls.query[0], {
      url: [
        "https://snap.dokitool.com/monitor",
        "https://snap.dokitool.com/monitor.html",
      ],
    });
    assert.deepEqual(calls.create, [
      { url: "https://snap.dokitool.com/monitor", active: true },
    ]);
    assert.equal(calls.create[0].url.includes("?"), false);
    assert.equal(calls.create[0].url.includes("#"), false);

    // Empty string also defaults to https://snap.dokitool.com/monitor
    calls.create.length = 0;
    assert.equal(await uiTargetHelpersMod.openMonitorDashboardTab(""), true);
    assert.deepEqual(calls.create, [
      { url: "https://snap.dokitool.com/monitor", active: true },
    ]);

    // 4) Reuses existing /monitor tab without calling tabs.create
    calls.create.length = 0;
    calls.update.length = 0;
    calls.windowUpdate.length = 0;
    existingTabs = [
      { id: 42, windowId: 7, url: "https://snap.dokitool.com/monitor" },
    ];
    assert.equal(
      await uiTargetHelpersMod.openMonitorDashboardTab("https://snap.dokitool.com/"),
      true,
    );
    assert.deepEqual(calls.update, [{ id: 42, props: { active: true } }]);
    assert.deepEqual(calls.windowUpdate, [{ wid: 7, props: { focused: true } }]);
    assert.equal(calls.create.length, 0);

    // 5) Reuses existing /monitor.html tab without calling tabs.create
    calls.create.length = 0;
    calls.update.length = 0;
    calls.windowUpdate.length = 0;
    existingTabs = [
      { id: 55, windowId: 9, url: "https://snap.dokitool.com/monitor.html" },
    ];
    assert.equal(await uiTargetHelpersMod.openMonitorDashboardTab(), true);
    assert.deepEqual(calls.update, [{ id: 55, props: { active: true } }]);
    assert.deepEqual(calls.windowUpdate, [{ wid: 9, props: { focused: true } }]);
    assert.equal(calls.create.length, 0);

    // 6) Loopback http://127.0.0.1:18080/ -> opens http://127.0.0.1:18080/monitor when absent
    calls.create.length = 0;
    calls.update.length = 0;
    existingTabs = [];
    assert.equal(
      await uiTargetHelpersMod.openMonitorDashboardTab("http://127.0.0.1:18080/"),
      true,
    );
    assert.deepEqual(calls.create, [
      { url: "http://127.0.0.1:18080/monitor", active: true },
    ]);
    assert.equal(calls.create[0].url.includes("?"), false);
    assert.equal(calls.create[0].url.includes("#"), false);

    // 7) Real Chrome portless match-pattern fallback when tabs.query throws on explicit port
    calls.create.length = 0;
    calls.update.length = 0;
    calls.windowUpdate.length = 0;
    globalThis.chrome.tabs.query = async ({ url }) => {
      const patterns = Array.isArray(url) ? url : [url];
      if (patterns.some((p) => /:\d+\//.test(p))) {
        throw new Error("Invalid url pattern");
      }
      return [
        { id: 88, windowId: 1, url: "http://127.0.0.1:9999/monitor" },
        { id: 89, windowId: 2, url: "http://127.0.0.1:18080/monitor.html" },
      ];
    };
    assert.equal(
      await uiTargetHelpersMod.openMonitorDashboardTab("http://127.0.0.1:18080"),
      true,
    );
    assert.deepEqual(calls.update, [{ id: 89, props: { active: true } }]);
    assert.deepEqual(calls.windowUpdate, [{ wid: 2, props: { focused: true } }]);
    assert.equal(calls.create.length, 0);
  } finally {
    if (prevChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = prevChrome;
  }
});

test("[PR-C Round 2] FETCH_OWNER_STATS RPC & SidePanelApp.vue owner-stats-pill: silent on anonymous/401, renders on 200 owner, and opens Web ${apiBaseUrl}/monitor with zero token in URL", async () => {
  assert.equal(
    protocol.isSidePanelRequest({ type: "FETCH_OWNER_STATS" }),
    true,
  );

  // Part A: Background FETCH_OWNER_STATS RPC
  const sampleStats = createOwnerStatsFixture();
  const rpcFetchCalls = [];
  const rpcStore = storage.createExtensionStorage({
    local: storage.createMemoryStorageArea(),
    session: storage.createMemoryStorageArea(),
  });
  const rpcEnv = createMockMv3Environment();
  const rpcBg = backgroundMod.createBackgroundController({
    chrome: rpcEnv.chrome,
    storage: rpcStore,
    now: () => 1_760_000_000_000,
    fetchImpl: async (url, init) => {
      rpcFetchCalls.push({ url: String(url), init });
      const auth = init?.headers?.Authorization || "";
      if (auth === "Bearer owner-secret-key") {
        return new Response(
          JSON.stringify({ schema_version: "1.0", code: "OK", data: sampleStats }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (auth === "Bearer bad-schema-key") {
        return new Response(
          JSON.stringify({ schema_version: "1.0", code: "OK", data: { broken: true } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          schema_version: "1.0",
          code: "INVALID_INPUT",
          error: { code: "UNAUTHORIZED", message: "owner token required" },
        }),
        { status: 401, headers: { "Content-Type": "application/json" } },
      );
    },
  });
  await rpcBg.init();

  const sendBgRpc = (msg) =>
    new Promise((resolvePromise) => {
      rpcBg.handleRuntimeMessage(msg, {}, resolvePromise);
    });

  try {
    // 1) Empty token -> 0 network calls, NO_TOKEN 401
    const noTokenRes = await sendBgRpc({ type: "FETCH_OWNER_STATS" });
    assert.equal(noTokenRes.ok, false);
    assert.equal(noTokenRes.status, 401);
    assert.equal(noTokenRes.code, "NO_TOKEN");
    assert.equal(rpcFetchCalls.length, 0);

    // 2) Friend token -> 401 UNAUTHORIZED with cookie-free / no-store options
    await rpcStore.updateSettings({ bearerToken: "friend-secret-key" });
    const friendRes = await sendBgRpc({ type: "FETCH_OWNER_STATS" });
    assert.equal(friendRes.ok, false);
    assert.equal(friendRes.status, 401);
    assert.equal(friendRes.code, "UNAUTHORIZED");
    assert.equal(rpcFetchCalls.length, 1);
    assert.equal(
      rpcFetchCalls[0].url,
      "https://snap.dokitool.com/api/stats?schema_version=1.0",
    );
    assert.equal(rpcFetchCalls[0].init.credentials, "omit");
    assert.equal(rpcFetchCalls[0].init.referrerPolicy, "no-referrer");
    assert.equal(rpcFetchCalls[0].init.cache, "no-store");
    assert.equal(
      rpcFetchCalls[0].init.headers.Authorization,
      "Bearer friend-secret-key",
    );

    // 3) Owner token -> 200 OK with validated StatsSnapshot
    await rpcStore.updateSettings({ bearerToken: "owner-secret-key" });
    const ownerRes = await sendBgRpc({ type: "FETCH_OWNER_STATS" });
    assert.equal(ownerRes.ok, true);
    assert.equal(ownerRes.data.apiOrigin, "https://snap.dokitool.com");
    assert.equal(ownerRes.data.fetchedAt, 1_760_000_000_000);
    assert.equal(ownerRes.data.stats.runtime.version, "v4.1.0-r2");

    // 4) Malformed 200 payload rejected cleanly
    await rpcStore.updateSettings({ bearerToken: "bad-schema-key" });
    const badRes = await sendBgRpc({ type: "FETCH_OWNER_STATS" });
    assert.equal(badRes.ok, false);
    assert.equal(badRes.code, "STATS_FAILED");
  } finally {
    rpcBg.dispose();
  }

  // Part B: Mounted SidePanelApp.vue owner stats capsule behavior
  const SidePanelApp = await loadSidePanelSfc("../src/extension/SidePanelApp.vue");
  const prevChrome = globalThis.chrome;

  async function mountScenario({ token = "", apiBaseUrl } = {}) {
    const fetchUrls = [];
    const tabCreateCalls = [];
    const store = storage.createExtensionStorage({
      local: storage.createMemoryStorageArea(),
      session: storage.createMemoryStorageArea(),
    });
    const patch = {};
    if (token) patch.bearerToken = token;
    if (apiBaseUrl) patch.apiBaseUrl = apiBaseUrl;
    if (Object.keys(patch).length > 0) {
      await store.updateSettings(patch);
    }

    const env = createMockMv3Environment();
    env.chrome.tabs.create = async (props) => {
      tabCreateCalls.push(props);
      return { id: 201 };
    };
    env.chrome.tabs.update = async () => ({});

    const bg = backgroundMod.createBackgroundController({
      chrome: env.chrome,
      storage: store,
      fetchImpl: async (url, init) => {
        fetchUrls.push(String(url));
        if (
          String(url).includes("/api/stats") &&
          init?.headers?.Authorization === `Bearer ${token}` &&
          token.startsWith("owner-")
        ) {
          return new Response(
            JSON.stringify({ schema_version: "1.0", code: "OK", data: sampleStats }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response(
          JSON.stringify({
            schema_version: "1.0",
            code: "INVALID_INPUT",
            error: { code: "UNAUTHORIZED", message: "forbidden" },
          }),
          { status: 401, headers: { "Content-Type": "application/json" } },
        );
      },
    });
    await bg.init();
    globalThis.chrome = env.chrome;

    const view = mountSfcTree(SidePanelApp);
    await new Promise((r) => setTimeout(r, 40));
    await view.flush();

    return {
      view,
      fetchUrls,
      tabCreateCalls,
      findByTestId: (id) =>
        view.findAll((n) => n.props?.["data-testid"] === id),
      cleanup() {
        view.unmount();
        bg.dispose();
      },
    };
  }

  try {
    // 1) Anonymous mode -> zero /api/stats fetch, pill hidden, header shows 匿名模式, zero alerts/toasts
    const anon = await mountScenario({ token: "" });
    try {
      assert.equal(anon.findByTestId("owner-stats-pill").length, 0);
      assert.equal(
        anon.view.textOf(anon.findByTestId("header-auth-pill")[0]).trim(),
        "匿名模式",
      );
      assert.equal(
        anon.fetchUrls.some((u) => u.includes("/api/stats")),
        false,
        "anonymous SidePanel must never request /api/stats",
      );
      assert.equal(
        anon.view.findAll((n) => n.props?.role === "alert").length,
        0,
      );
      assert.equal(
        anon.view.findAll((n) => n.props?.role === "status").length,
        0,
      );
    } finally {
      anon.cleanup();
    }

    // 2) Friend 401 -> pill hidden silently, header stays Bearer 已就绪, zero alert/toast
    const friend = await mountScenario({ token: "friend-tok-123" });
    try {
      assert.equal(friend.findByTestId("owner-stats-pill").length, 0);
      assert.equal(
        friend.view.textOf(friend.findByTestId("header-auth-pill")[0]).trim(),
        "Bearer 已就绪",
      );
      assert.equal(
        friend.fetchUrls.some((u) => u.includes("/api/stats")),
        true,
      );
      assert.equal(
        friend.view.findAll((n) => n.props?.role === "alert").length,
        0,
      );
      assert.equal(
        friend.view.findAll((n) => n.props?.role === "status").length,
        0,
      );
    } finally {
      friend.cleanup();
    }

    // 3) Owner 200 (default production origin) -> header upgrades to Owner 已就绪,
    //    capsule prioritizes effectiveSuccessRate, shows dual hover metrics + click-to-refresh,
    //    and opens https://snap.dokitool.com/monitor
    const prodOwner = await mountScenario({ token: "owner-prod-secret-xyz" });
    try {
      assert.equal(
        prodOwner.view.textOf(prodOwner.findByTestId("header-auth-pill")[0]).trim(),
        "Owner 已就绪",
      );
      const pills = prodOwner.findByTestId("owner-stats-pill");
      assert.equal(pills.length, 1);
      const pillText = prodOwner.view.textOf(pills[0]);
      assert.match(pillText, /今日 120 次/);
      assert.match(pillText, /95\.0%/);
      assert.match(pillText, /上海 2 节点/);
      assert.match(pillText, /解析监控大盘/);
      assert.equal(
        prodOwner.view.textOf().includes("owner-prod-secret-xyz"),
        false,
        "SidePanel DOM must never expose raw bearerToken",
      );

      // Hover title includes both 有效成功率 and 原始成功率 + 点击刷新
      const refreshBtn = prodOwner.findByTestId("owner-stats-refresh-btn")[0];
      assert.ok(refreshBtn);
      assert.match(refreshBtn.props.title, /有效成功率 95\.0%/);
      assert.match(refreshBtn.props.title, /原始成功率 95\.0%/);
      assert.match(refreshBtn.props.title, /点击刷新/);

      // Clicking metrics area triggers a manual /api/stats refresh (does not open monitor tab)
      const statsFetchesBefore = prodOwner.fetchUrls.filter((u) =>
        u.includes("/api/stats"),
      ).length;
      await prodOwner.view.fire(refreshBtn, "onClick");
      await new Promise((r) => setTimeout(r, 30));
      await prodOwner.view.flush();
      const statsFetchesAfter = prodOwner.fetchUrls.filter((u) =>
        u.includes("/api/stats"),
      ).length;
      assert.equal(statsFetchesAfter, statsFetchesBefore + 1);
      assert.equal(prodOwner.tabCreateCalls.length, 0);

      const openBtn = prodOwner.findByTestId("open-monitor-dashboard-btn")[0];
      await prodOwner.view.fire(openBtn, "onClick");
      assert.deepEqual(prodOwner.tabCreateCalls, [
        { url: "https://snap.dokitool.com/monitor", active: true },
      ]);
      const openedUrl = prodOwner.tabCreateCalls[0].url;
      assert.equal(openedUrl.includes("owner-prod-secret-xyz"), false);
      assert.equal(openedUrl.includes("?"), false);
      assert.equal(openedUrl.includes("#"), false);
    } finally {
      prodOwner.cleanup();
    }

    // 3b) Effective vs raw rate divergence: 108/120 raw (90.0%) vs 108/112 effective (96.4%) -> capsule displays 96.4%
    const originalByPlatform = sampleStats.daily[1].by_platform;
    const originalOk = sampleStats.daily[1].ok;
    const originalFailed = sampleStats.daily[1].failed;
    sampleStats.daily[1].ok = 108;
    sampleStats.daily[1].failed = 12;
    sampleStats.daily[1].by_platform = {
      bilibili: {
        total: 112,
        ok: 108,
        failed: 4,
        by_code: { OK: 108, UPSTREAM_BLOCKED: 4 },
        p95_ms: 820,
      },
      unknown: {
        total: 8,
        ok: 0,
        failed: 8,
        by_code: { INVALID_INPUT: 5, RATE_LIMITED: 3 },
        p95_ms: 10,
      },
    };
    const effOwner = await mountScenario({ token: "owner-eff-secret-xyz" });
    try {
      const rateEl = effOwner.findByTestId("owner-stats-rate")[0];
      assert.equal(effOwner.view.textOf(rateEl).trim(), "96.4%");
      const refreshBtn = effOwner.findByTestId("owner-stats-refresh-btn")[0];
      assert.match(refreshBtn.props.title, /有效成功率 96\.4%/);
      assert.match(refreshBtn.props.title, /原始成功率 90\.0%/);
      assert.match(refreshBtn.props.title, /点击刷新/);
    } finally {
      effOwner.cleanup();
      sampleStats.daily[1].by_platform = originalByPlatform;
      sampleStats.daily[1].ok = originalOk;
      sampleStats.daily[1].failed = originalFailed;
    }

    // 4) Owner 200 (custom loopback apiBaseUrl) -> opens http://127.0.0.1:18080/monitor with zero token in URL
    const loopbackOwner = await mountScenario({
      token: "owner-loopback-secret-999",
      apiBaseUrl: "http://127.0.0.1:18080/",
    });
    try {
      assert.equal(loopbackOwner.findByTestId("owner-stats-pill").length, 1);
      const openBtn = loopbackOwner.findByTestId("open-monitor-dashboard-btn")[0];
      await loopbackOwner.view.fire(openBtn, "onClick");
      assert.deepEqual(loopbackOwner.tabCreateCalls, [
        { url: "http://127.0.0.1:18080/monitor", active: true },
      ]);
      const openedUrl = loopbackOwner.tabCreateCalls[0].url;
      assert.equal(openedUrl.includes("owner-loopback-secret-999"), false);
      assert.equal(openedUrl.includes("?"), false);
      assert.equal(openedUrl.includes("#"), false);
    } finally {
      loopbackOwner.cleanup();
    }
  } finally {
    if (prevChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = prevChrome;
  }
});

test("PR 1 UX: single-P Bilibili stays single-video with clean media.title filename, while true multi-P and albums use compact save-mode pills and unified primary CTA", async () => {
  const SidePanelResult = await loadSidePanelSfc(
    "../src/extension/components/SidePanelResult.vue",
  );
  const baseSettings = {
    apiBaseUrl: "https://snap.dokitool.com",
    bearerToken: "",
    subfolderPrefix: "",
    batchSaveMode: "subfolder",
    qualityPreference: "best",
    autoFollowTab: false,
    theme: "system",
  };

  // 1) Single-P Bilibili video returning groups:[{id:"parts", total_count:1}] and raw mmexport part title
  const singlePBiliMedia = {
    platform: "bilibili",
    content_id: "BV1SingleP1234",
    title: "B站单P真实主标题测试",
    source_url: "https://www.bilibili.com/video/BV1SingleP1234",
    default_item_id: "p1",
    groups: [
      {
        id: "parts",
        kind: "multipart",
        title: "分P",
        total_count: 1,
        item_ids: ["p1"],
      },
    ],
    items: [
      {
        id: "p1",
        type: "video",
        index: 1,
        title: "mmexport1794208831102.mp4",
        state: "ready",
        default: {
          variant_id: "durl-720p",
          source_id: "s-720",
          url: "https://upos-sz-mirrorcos.bilivideo.com/single-720.mp4",
        },
        variants: [
          {
            id: "dash-1080p",
            label: "1080P 高清",
            metadata: {
              width: 1920,
              height: 1080,
              video_codec: "avc1.640032",
              bitrate_bps: 2_800_000,
              has_audio: true,
              container: "mp4",
              extension: "mp4",
            },
            delivery: {
              kind: "mux",
              output: { container: "mp4", extension: "mp4" },
              resources: [
                {
                  id: "v-1080",
                  role: "video",
                  metadata: { width: 1920, height: 1080, video_codec: "avc1.640032" },
                  delivery: {
                    kind: "file",
                    sources: [
                      {
                        id: "s-1080",
                        url: "https://upos-sz-mirrorcos.bilivideo.com/single-1080.m4s",
                        size_bytes: 18_000_000,
                      },
                    ],
                  },
                },
                {
                  id: "a-30280",
                  role: "audio",
                  metadata: { audio_codec: "mp4a.40.2" },
                  delivery: {
                    kind: "file",
                    sources: [
                      {
                        id: "s-audio",
                        url: "https://upos-sz-mirrorcos.bilivideo.com/single-audio.m4s",
                        size_bytes: 2_000_000,
                      },
                    ],
                  },
                },
              ],
            },
          },
          {
            id: "durl-720p",
            label: "720P 高清",
            metadata: {
              width: 1280,
              height: 720,
              video_codec: "avc1.64001F",
              has_audio: true,
              container: "mp4",
              extension: "mp4",
            },
            delivery: {
              kind: "file",
              sources: [
                {
                  id: "s-720",
                  url: "https://upos-sz-mirrorcos.bilivideo.com/single-720.mp4",
                  size_bytes: 9_000_000,
                },
              ],
            },
          },
        ],
        attachments: [
          {
            id: "dash-audio-30280",
            role: "audio",
            metadata: {
              bitrate_bps: 192_000,
              audio_codec: "mp4a.40.2",
              container: "m4a",
              extension: "m4a",
            },
            delivery: {
              kind: "file",
              sources: [
                {
                  id: "s-audio",
                  url: "https://upos-sz-mirrorcos.bilivideo.com/single-audio.m4s",
                },
              ],
            },
          },
        ],
      },
    ],
  };

  assert.equal(uiTargetHelpersMod.classifyMediaLayout(singlePBiliMedia), "single");
  const singleOpts = uiTargetHelpersMod.buildSidePanelQualityOptions(
    singlePBiliMedia,
    singlePBiliMedia.items[0],
    "https://snap.dokitool.com",
  );
  const dash1080Opt = singleOpts.find((o) => o.isDashMux);
  assert.ok(dash1080Opt);
  const singleEnqueue = uiTargetHelpersMod.buildSingleDownloadEnqueueItem({
    media: singlePBiliMedia,
    item: singlePBiliMedia.items[0],
    option: dash1080Opt,
    settings: baseSettings,
  });
  assert.ok(singleEnqueue);
  assert.equal(singleEnqueue.spec.filename, "B站单P真实主标题测试.mp4");
  assert.equal(singleEnqueue.spec.filename.includes("/"), false);
  assert.equal(singleEnqueue.spec.filename.includes("mmexport"), false);
  assert.equal(singleEnqueue.spec.filename.includes("001_"), false);

  const bgSingleItems = extensionDownloadMod.buildEnqueueItemsForMedia(singlePBiliMedia, {
    qualityPreference: "best",
    batchSaveMode: "subfolder",
    subfolderPrefix: "",
  });
  assert.equal(bgSingleItems.length, 1);
  assert.equal(bgSingleItems[0].spec.filename, "B站单P真实主标题测试.mp4");
  assert.equal(bgSingleItems[0].spec.filename.includes("/"), false);

  // Mount SidePanelResult for single-P Bilibili -> pure single-video UI!
  const singleView = mountSfcTree(SidePanelResult, {
    media: singlePBiliMedia,
    workFingerprint: "bilibili:BV1SingleP1234",
    isSaved: false,
    settings: baseSettings,
    resolvingItemIds: new Set(),
  });
  try {
    await singleView.flush();
    const text = singleView.textOf();
    assert.equal(text.includes("分P"), false, "single-P Bilibili must NOT render 分P list");
    assert.equal(text.includes("存子文件夹"), false, "single-P Bilibili must NOT render subfolder toggle");
    assert.equal(text.includes("打包 ZIP"), false, "single-P Bilibili must NOT render ZIP toggle");
    assert.equal(text.includes("仅下当前集"), false, "single-P Bilibili must NOT render 仅下当前集");
    const mainBtn = singleView.findAll(
      (n) =>
        n.type === "button" &&
        typeof n.props.class === "string" &&
        n.props.class.includes("sp-cta-row__main"),
    )[0];
    assert.ok(mainBtn);
    assert.ok(singleView.textOf(mainBtn).includes("下载视频 (1080p)"));
  } finally {
    singleView.unmount();
  }

  // 2) True 2-P Bilibili video -> multi_video layout, subfolder episode naming, compact pills + unified primary CTA
  const multiPBiliMedia = {
    platform: "bilibili",
    content_id: "BV1MultiP5678",
    title: "B站两集课程",
    source_url: "https://www.bilibili.com/video/BV1MultiP5678",
    default_item_id: "p1",
    groups: [
      {
        id: "parts",
        kind: "multipart",
        title: "分P",
        total_count: 2,
        item_ids: ["p1", "p2"],
      },
    ],
    items: [
      {
        id: "p1",
        type: "video",
        index: 1,
        title: "第一集",
        state: "ready",
        default: {
          variant_id: "v1-720",
          source_id: "s1",
          url: "https://upos-sz-mirrorcos.bilivideo.com/ep1-720.mp4",
        },
        variants: [
          {
            id: "v1-720",
            label: "720P",
            metadata: { width: 1280, height: 720, has_audio: true, extension: "mp4" },
            delivery: {
              kind: "file",
              sources: [
                {
                  id: "s1",
                  url: "https://upos-sz-mirrorcos.bilivideo.com/ep1-720.mp4",
                  size_bytes: 5_000_000,
                },
              ],
            },
          },
        ],
      },
      {
        id: "p2",
        type: "video",
        index: 2,
        title: "第二集",
        state: "ready",
        default: {
          variant_id: "v2-720",
          source_id: "s2",
          url: "https://upos-sz-mirrorcos.bilivideo.com/ep2-720.mp4",
        },
        variants: [
          {
            id: "v2-720",
            label: "720P",
            metadata: { width: 1280, height: 720, has_audio: true, extension: "mp4" },
            delivery: {
              kind: "file",
              sources: [
                {
                  id: "s2",
                  url: "https://upos-sz-mirrorcos.bilivideo.com/ep2-720.mp4",
                  size_bytes: 6_000_000,
                },
              ],
            },
          },
        ],
      },
    ],
  };

  assert.equal(uiTargetHelpersMod.classifyMediaLayout(multiPBiliMedia), "multi_video");
  const bgMultiItems = extensionDownloadMod.buildEnqueueItemsForMedia(multiPBiliMedia, {
    qualityPreference: "best",
    batchSaveMode: "subfolder",
    subfolderPrefix: "",
  });
  assert.deepEqual(
    bgMultiItems.map((it) => it.spec.filename),
    ["B站两集课程/001_第一集.mp4", "B站两集课程/002_第二集.mp4"],
  );

  const multiEnqueues = [];
  const multiView = mountSfcTree(
    SidePanelResult,
    {
      media: multiPBiliMedia,
      workFingerprint: "bilibili:BV1MultiP5678",
      isSaved: false,
      settings: baseSettings,
      resolvingItemIds: new Set(),
    },
    { onEnqueueDownloads: (payload) => multiEnqueues.push(payload) },
  );
  try {
    await multiView.flush();
    const text = multiView.textOf();
    assert.equal(text.includes("仅下当前集"), false, "multi_video must NOT render top 仅下当前集 bar");
    assert.equal(text.includes("按标题存子文件夹"), false, "multi_video must NOT use verbose subfolder CTA text");
    const primaryBtn = () =>
      multiView.findAll(
        (n) =>
          n.type === "button" &&
          typeof n.props.class === "string" &&
          n.props.class.includes("sp-batch-actions__primary"),
      )[0];
    assert.ok(multiView.textOf(primaryBtn()).includes("下载全部 (2)"));

    // Uncheck 1 episode -> primary CTA updates to 下载已选 (1/2)
    const checks = multiView.findAll(
      (n) =>
        n.type === "button" &&
        typeof n.props.class === "string" &&
        n.props.class.includes("sp-ep-row__check"),
    );
    await multiView.fire(checks[0], "onClick", { stopPropagation() {} });
    assert.ok(multiView.textOf(primaryBtn()).includes("下载已选 (1/2)"));

    // Re-check -> switch to 打包 ZIP pill -> clicking primary enqueues batch_zip
    await multiView.fire(checks[0], "onClick", { stopPropagation() {} });
    const zipPill = multiView.findAll(
      (n) => n.type === "button" && n.props["data-save-mode"] === "zip",
    )[0];
    await multiView.fire(zipPill, "onClick");
    await multiView.fire(primaryBtn(), "onClick");
    assert.equal(multiEnqueues.length, 1);
    assert.equal(multiEnqueues[0].items[0].spec.kind, "batch_zip");
  } finally {
    multiView.unmount();
  }

  // 3) Album (>= 2 images) layout uses compact save-mode pills + unified primary CTA
  const albumMedia = {
    platform: "xiaohongshu",
    content_id: "xhs-album-3",
    title: "三图测试图集",
    items: [1, 2, 3].map((idx) => ({
      id: `img-${idx}`,
      type: "image",
      index: idx,
      state: "ready",
      default: {
        variant_id: "v0",
        source_id: "s0",
        url: `https://sns-webpic-qc.xhscdn.com/album-${idx}.jpg`,
      },
      variants: [
        {
          id: "v0",
          metadata: { extension: "jpg" },
          delivery: {
            kind: "file",
            sources: [
              {
                id: "s0",
                url: `https://sns-webpic-qc.xhscdn.com/album-${idx}.jpg`,
                size_bytes: 1_000_000,
              },
            ],
          },
        },
      ],
    })),
  };
  assert.equal(uiTargetHelpersMod.classifyMediaLayout(albumMedia), "album");
  const albumEnqueues = [];
  const albumView = mountSfcTree(
    SidePanelResult,
    {
      media: albumMedia,
      workFingerprint: "xiaohongshu:xhs-album-3",
      isSaved: false,
      settings: baseSettings,
      resolvingItemIds: new Set(),
    },
    { onEnqueueDownloads: (payload) => albumEnqueues.push(payload) },
  );
  try {
    await albumView.flush();
    assert.equal(albumView.textOf().includes("按标题存子文件夹"), false);
    assert.equal(albumView.textOf().includes("仅下当前项"), false);
    const primaryBtn = () =>
      albumView.findAll(
        (n) =>
          n.type === "button" &&
          typeof n.props.class === "string" &&
          n.props.class.includes("sp-batch-actions__primary"),
      )[0];
    assert.ok(albumView.textOf(primaryBtn()).includes("下载全部 (3)"));
    const zipPill = albumView.findAll(
      (n) => n.type === "button" && n.props["data-save-mode"] === "zip",
    )[0];
    await albumView.fire(zipPill, "onClick");
    await albumView.fire(primaryBtn(), "onClick");
    assert.equal(albumEnqueues.length, 1);
    assert.equal(albumEnqueues[0].items[0].spec.kind, "batch_zip");
  } finally {
    albumView.unmount();
  }
});

test("[PR3] opfsStreamTransfer defaults: 3 MiB parallel Range threshold and DASH audio maxConcurrency=2", async () => {
  assert.equal(
    opfsStreamTransferMod.DEFAULT_RANGE_CONCURRENCY_THRESHOLD_BYTES,
    3 * 1024 * 1024,
  );
  assert.equal(opfsStreamTransferMod.DEFAULT_DASH_AUDIO_MAX_CONCURRENCY, 2);

  // 3.5 MiB file with 1 MiB chunks activates parallel Range under default minParallelRangeBytes (3 MiB).
  const runSize = async (byteLength) => {
    const payload = makeDeterministicPayload(byteLength, 73);
    const opfs = createMockOpfs();
    let inFlight = 0;
    let maxInFlight = 0;
    const res = await opfsStreamTransferMod.streamResumableRouteToOpfs({
      taskId: `thresh-${byteLength}`,
      routes: ["https://upos-sz-mirrorcos.bilivideo.com/thresh.mp4"],
      spec: {
        kind: "direct_file",
        apiOrigin: "https://snap.dokitool.com",
        routes: ["https://upos-sz-mirrorcos.bilivideo.com/thresh.mp4"],
        filename: "thresh.mp4",
      },
      fetchFn: async (_url, init) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        try {
          const parsed = parseTestRangeHeader(init?.headers?.Range);
          if (parsed) {
            const start = parsed.start;
            const end = Math.min(payload.byteLength - 1, parsed.end ?? payload.byteLength - 1);
            await new Promise((r) => setTimeout(r, start === 0 ? 1 : 20));
            const slice = payload.subarray(start, end + 1);
            return new Response(slice, {
              status: 206,
              headers: {
                "Content-Type": "video/mp4",
                "Content-Range": `bytes ${start}-${end}/${payload.byteLength}`,
                "Content-Length": String(slice.byteLength),
              },
            });
          }
          return new Response(payload, {
            status: 200,
            headers: {
              "Content-Type": "video/mp4",
              "Content-Length": String(payload.byteLength),
            },
          });
        } finally {
          inFlight -= 1;
        }
      },
      openOpfsSink: makeTestOpfsSink(opfs),
      signal: new AbortController().signal,
      estimatedSize: byteLength,
      maxConcurrency: 4,
      rangeChunkSizeBytes: 1024 * 1024,
    });
    const blob = await res.sink.closeAndGetBlob();
    assert.equal(sha256Hex(new Uint8Array(await blob.arrayBuffer())), sha256Hex(payload));
    await res.sink.cleanup();
    return { parallelUsed: res.parallelUsed, maxInFlight };
  };

  const over3MiB = await runSize(Math.floor(3.5 * 1024 * 1024));
  assert.equal(over3MiB.parallelUsed, true, "3.5 MiB must activate parallel Range with 3 MiB threshold");
  assert.ok(over3MiB.maxInFlight >= 2, `expected parallel workers on 3.5 MiB, got ${over3MiB.maxInFlight}`);

  const under3MiB = await runSize(Math.floor(2.5 * 1024 * 1024));
  assert.equal(under3MiB.parallelUsed, false, "2.5 MiB (< 3 MiB) must stay single-stream");
  assert.equal(under3MiB.maxInFlight, 1);
});

test("[PR3] Background Controller throttles badge/tooltip progress updates when SidePanel is closed while flushing state transitions immediately", async () => {
  assert.equal(backgroundMod.DEFAULT_BADGE_PROGRESS_THROTTLE_MS, 1_000);

  const env = createMockMv3Environment({ autoCompleteDownloads: false });
  let startedTaskId = "";
  let fakeNow = 10_000;

  env.chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === "OFFSCREEN_START_TASK") {
      startedTaskId = msg.taskId;
      sendResponse({ ok: true, data: { accepted: true } });
      return true;
    }
    if (msg?.type === "RELEASE_BLOB") {
      sendResponse({ ok: true, data: { released: true } });
      return true;
    }
    return false;
  });

  const extStorage = storage.createExtensionStorage();
  const bg = backgroundMod.createBackgroundController({
    chrome: env.chrome,
    storage: extStorage,
    now: () => fakeNow,
    badgeSuccessDurationMs: 40,
    badgeProgressThrottleMs: 80,
  });

  try {
    await bg.init();
    env.badgeHistory.length = 0;

    // Enqueue single direct_file task with SidePanel CLOSED (0 connected ports).
    const enq = await env.chrome.runtime.sendMessage({
      type: "ENQUEUE_DOWNLOADS",
      items: [
        {
          title: "节流测试视频",
          platform: "bilibili",
          spec: {
            kind: "direct_file",
            apiOrigin: "https://snap.dokitool.com",
            routes: ["https://upos-sz-mirrorcos.bilivideo.com/throttle.mp4"],
            filename: "throttle.mp4",
            sizeBytes: 100_000_000,
          },
        },
      ],
    });
    const taskId = enq.data.taskIds[0];
    for (let i = 0; i < 30 && !startedTaskId; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    assert.equal(startedTaskId, taskId);
    env.badgeHistory.length = 0;

    // 1) Leading-edge progress tick flushes immediately (10%).
    fakeNow = 10_100;
    await env.chrome.runtime.sendMessage({
      type: "OFFSCREEN_TASK_PROGRESS",
      taskId,
      status: "downloading",
      statusText: "正在下载...",
      percent: 10,
      loaded: 10_000_000,
      total: 100_000_000,
      speed: 2_000_000,
    });
    assert.deepEqual(
      env.badgeHistory.filter((e) => e.kind === "text").map((e) => e.text),
      ["10%"],
    );

    // 2) Rapid ticks within throttle window (<80ms) MUST coalesce with ZERO immediate Chrome IPC!
    env.badgeHistory.length = 0;
    for (const [dt, pct, speed] of [
      [10, 20, 2_500_000],
      [20, 30, 3_000_000],
      [30, 45, 3_500_000],
    ]) {
      fakeNow = 10_100 + dt;
      await env.chrome.runtime.sendMessage({
        type: "OFFSCREEN_TASK_PROGRESS",
        taskId,
        status: "downloading",
        statusText: "正在下载...",
        percent: pct,
        loaded: pct * 1_000_000,
        total: 100_000_000,
        speed,
      });
    }
    assert.equal(
      env.badgeHistory.length,
      0,
      "Rapid closed-SidePanel progress ticks within throttle window must coalesce",
    );

    // 3) After throttle window elapses, trailing flush emits ONLY the latest coalesced state (45%)!
    fakeNow = 10_200;
    await new Promise((r) => setTimeout(r, 110));
    assert.deepEqual(
      env.badgeHistory.filter((e) => e.kind === "text").map((e) => e.text),
      ["45%"],
    );
    assert.match(
      env.badgeHistory.filter((e) => e.kind === "title").at(-1)?.title ?? "",
      /45% \(3\.5 MB\/s\)/,
    );

    // 4) Queue another throttled progress tick (55%), then trigger a state transition (downloading -> muxing 80%) -> MUST flush immediately!
    env.badgeHistory.length = 0;
    fakeNow = 10_210;
    await env.chrome.runtime.sendMessage({
      type: "OFFSCREEN_TASK_PROGRESS",
      taskId,
      status: "downloading",
      statusText: "正在下载...",
      percent: 55,
      loaded: 55_000_000,
      total: 100_000_000,
      speed: 4_000_000,
    });
    assert.equal(env.badgeHistory.length, 0, "55% tick throttled inside window");

    fakeNow = 10_220;
    await env.chrome.runtime.sendMessage({
      type: "OFFSCREEN_TASK_PROGRESS",
      taskId,
      status: "muxing",
      statusText: "正在合流...",
      percent: 80,
      loaded: 80_000_000,
      total: 100_000_000,
      speed: 0,
    });
    assert.deepEqual(
      env.badgeHistory.filter((e) => e.kind === "text").map((e) => e.text),
      ["80%"],
      "Stage transition downloading -> muxing must flush immediately without waiting for throttle timer",
    );

    // 5) Opening SidePanel flushes any pending throttled tick and disables throttling while open!
    env.badgeHistory.length = 0;
    fakeNow = 10_225;
    await env.chrome.runtime.sendMessage({
      type: "OFFSCREEN_TASK_PROGRESS",
      taskId,
      status: "muxing",
      statusText: "正在合流...",
      percent: 84,
      loaded: 84_000_000,
      total: 100_000_000,
      speed: 0,
    });
    // First muxing progress-only tick (84%) flushes leading edge; next tick (88%) is throttled.
    fakeNow = 10_235;
    await env.chrome.runtime.sendMessage({
      type: "OFFSCREEN_TASK_PROGRESS",
      taskId,
      status: "muxing",
      statusText: "正在合流...",
      percent: 88,
      loaded: 88_000_000,
      total: 100_000_000,
      speed: 0,
    });
    assert.deepEqual(
      env.badgeHistory.filter((e) => e.kind === "text").map((e) => e.text),
      ["84%"],
    );

    const spPort = env.chrome.runtime.connect({
      name: protocol.SIDEPANEL_PORT_NAME,
    });
    assert.equal(
      env.badgeHistory.filter((e) => e.kind === "text").at(-1)?.text,
      "88%",
      "Connecting SidePanel must immediately flush pending throttled badge update",
    );

    // While SidePanel is open, rapid progress ticks flush immediately.
    env.badgeHistory.length = 0;
    fakeNow = 10_240;
    await env.chrome.runtime.sendMessage({
      type: "OFFSCREEN_TASK_PROGRESS",
      taskId,
      status: "muxing",
      statusText: "正在合流...",
      percent: 91,
      loaded: 91_000_000,
      total: 100_000_000,
      speed: 0,
    });
    fakeNow = 10_245;
    await env.chrome.runtime.sendMessage({
      type: "OFFSCREEN_TASK_PROGRESS",
      taskId,
      status: "muxing",
      statusText: "正在合流...",
      percent: 94,
      loaded: 94_000_000,
      total: 100_000_000,
      speed: 0,
    });
    assert.deepEqual(
      env.badgeHistory.filter((e) => e.kind === "text").map((e) => e.text),
      ["91%", "94%"],
      "Progress ticks must not throttle while SidePanel is connected",
    );

    // Close SidePanel, queue a throttled tick, then fail -> terminal "!" flushes IMMEDIATELY!
    spPort.disconnect();
    env.badgeHistory.length = 0;
    fakeNow = 10_250;
    await env.chrome.runtime.sendMessage({
      type: "OFFSCREEN_TASK_PROGRESS",
      taskId,
      status: "muxing",
      statusText: "正在合流...",
      percent: 96,
      loaded: 96_000_000,
      total: 100_000_000,
      speed: 0,
    });
    assert.equal(env.badgeHistory.length, 0, "Closed SidePanel re-enables throttling");

    fakeNow = 10_255;
    await env.chrome.runtime.sendMessage({
      type: "OFFSCREEN_TASK_ERROR",
      taskId,
      error: "synthetic failure",
    });
    assert.equal(
      env.badgeHistory.filter((e) => e.kind === "text").at(-1)?.text,
      "!",
      "Terminal failure must flush immediately even during throttle window",
    );
  } finally {
    bg.dispose();
  }
});

test("Issue #48 [P0-2] Spec B.2: createFetchGmXhrAdapter streams ReadableStream onprogress (150ms) and createSmoothedSpeedEstimator prevents sawtooth zero flicker", async () => {
  // 1. Streaming ReadableStream arraybuffer adapter emits incremental onprogress at 150ms cadence & exact bytes
  let fakeNow = 1_000;
  const partA = new Uint8Array([1, 2, 3, 4]);
  const partB = new Uint8Array([5, 6, 7, 8]);
  const partC = new Uint8Array([9, 10, 11, 12]);
  const mockStreamFetch = async () => {
    const stream = new ReadableStream({
      start(ctrl) {
        ctrl.enqueue(partA);
        fakeNow += 50; // within 150ms window
        ctrl.enqueue(partB);
        fakeNow += 160; // crosses 150ms cadence
        ctrl.enqueue(partC);
        ctrl.close();
      },
    });
    return new Response(stream, {
      status: 206,
      headers: { "content-length": "12", "content-range": "bytes 0-11/12" },
    });
  };

  const gmXhr = youtubeBridgeMod.createFetchGmXhrAdapter({
    fetchImpl: mockStreamFetch,
    progressIntervalMs: 150,
    now: () => fakeNow,
  });

  const progressTicks = [];
  const loadResult = await new Promise((resolve, reject) => {
    gmXhr({
      method: "GET",
      url: "https://rr1---sn-test.googlevideo.com/videoplayback?itag=137&range=0-11",
      responseType: "arraybuffer",
      onprogress(ev) {
        progressTicks.push(ev);
      },
      onload: resolve,
      onerror: reject,
    });
  });

  assert.equal(loadResult.status, 206);
  assert.deepEqual(
    Array.from(new Uint8Array(loadResult.response)),
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
  );
  assert.ok(progressTicks.length >= 2, `expected streaming onprogress ticks, got ${progressTicks.length}`);
  assert.equal(progressTicks[0].loaded, 4);
  assert.equal(progressTicks.at(-1).loaded, 12);
  assert.equal(progressTicks.at(-1).total, 12);

  // 2. Sliding 2.5s window + EWMA (tau=1.2s) speed estimator holds steady across brief pauses and decays to 0 only after >= 2500ms idle
  const est = extensionDownloadMod.createSmoothedSpeedEstimator({ startedAt: 0 });
  const s1 = est.update(1_000_000, 500); // 2.0 MB/s
  assert.equal(s1, 2_000_000);
  const s2 = est.update(2_000_000, 1000); // still 2.0 MB/s
  assert.ok(s2 >= 1_900_000 && s2 <= 2_100_000, `expected smooth ~2MB/s, got ${s2}`);

  // Brief 1200ms chunk-switch pause with 0 new bytes MUST NOT flicker to 0!
  const paused = est.update(2_000_000, 2200);
  assert.equal(paused, s2, "speed must stay held during < 2500ms chunk transition gap");

  // Continuous stall >= 2500ms (1000 -> 3500ms) cleanly decays speed to 0
  const stalled = est.update(2_000_000, 3500);
  assert.equal(stalled, 0, "speed must decay to 0 after >= 2500ms with no new bytes");

  // Resuming after stall computes clean fresh rate without dividing by stale stall duration
  const resumed = est.update(3_000_000, 4000); // 1 MB in 500ms = 2 MB/s
  assert.equal(resumed, 2_000_000);
});

test("Issue #48 [P1-6] & [P2-5d]: 3-way parallel context+prefetch, short-TTL context cache + 1x player_id 400 retry, 3-stage PARSE_PROGRESS, and zero hardcoded 4K mux copy", async () => {
  const opfs = createMockOpfs();
  const urlApi = createTrackedUrlApi();
  let contextCalls = 0;
  let swDataCalls = 0;
  let oembedCalls = 0;
  let finalizeCalls = 0;
  let failNextFinalizeStale = false;
  let sawConcurrentContextAndPrefetch = false;
  let inFlightContext = false;
  let inFlightPrefetch = false;
  let releaseContextBarrier = null;
  let releaseSwBarrier = null;

  const mockFetch = async (url) => {
    if (url.startsWith("https://snap.dokitool.com/api/youtube/context")) {
      contextCalls++;
      inFlightContext = true;
      if (inFlightPrefetch) sawConcurrentContextAndPrefetch = true;
      if (contextCalls === 1) {
        await new Promise((resolve) => {
          releaseContextBarrier = resolve;
          if (inFlightPrefetch && releaseSwBarrier) {
            releaseSwBarrier();
            resolve();
          }
        });
      }
      inFlightContext = false;
      return new Response(
        JSON.stringify({
          schema_version: "1.0",
          code: "OK",
          data: {
            player_id: `pl-${contextCalls}`,
            signature_timestamp: 20123 + contextCalls,
            client: { name: "TVHTML5", version: "7.20260101.00.00" },
            expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    if (url === "https://www.youtube.com/sw.js_data") {
      swDataCalls++;
      inFlightPrefetch = true;
      if (inFlightContext) sawConcurrentContextAndPrefetch = true;
      if (swDataCalls === 1) {
        await new Promise((resolve) => {
          releaseSwBarrier = resolve;
          if (inFlightContext && releaseContextBarrier) {
            releaseContextBarrier();
            resolve();
          }
        });
      }
      inFlightPrefetch = false;
      return new Response(`)]}'\n[[null,null,[null,null,null,null,null,null,"CgtnVmlzaXRvckRhdGE%3D"]]]`, {
        status: 200,
      });
    }

    if (url.startsWith("https://www.youtube.com/oembed")) {
      oembedCalls++;
      return new Response(
        JSON.stringify({
          title: "Parallel Prefetch Title",
          author_name: "Parallel Author",
          thumbnail_url: "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    if (url.startsWith("https://www.youtube.com/youtubei/v1/player")) {
      return new Response(
        JSON.stringify({
          playabilityStatus: { status: "OK" },
          streamingData: {
            formats: [
              {
                itag: 18,
                url: "https://rr1---sn-test.googlevideo.com/videoplayback?itag=18",
                mimeType: 'video/mp4; codecs="avc1.42001E, mp4a.40.2"',
                width: 640,
                height: 360,
              },
            ],
            adaptiveFormats: [],
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    if (url.startsWith("https://snap.dokitool.com/api/youtube/finalize")) {
      finalizeCalls++;
      if (failNextFinalizeStale) {
        failNextFinalizeStale = false;
        return new Response(
          JSON.stringify({
            schema_version: "1.0",
            code: "INVALID_INPUT",
            error: { code: "INVALID_INPUT", message: "player_id 已失效或不存在" },
          }),
          { status: 400, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          schema_version: "1.0",
          code: "OK",
          data: {
            platform: "youtube",
            content_id: "dQw4w9WgXcQ",
            source_url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
            title: "Parallel Prefetch Title",
            items: [
              {
                id: "yt-1",
                type: "video",
                variants: [
                  {
                    id: "360p",
                    label: "360p",
                    metadata: { width: 640, height: 360, extension: "mp4", has_audio: true },
                    delivery: {
                      kind: "file",
                      sources: [{ id: "s1", url: "https://rr1---sn-test.googlevideo.com/videoplayback?itag=18" }],
                    },
                  },
                ],
                default: { variant_id: "360p", source_id: "s1", url: "https://rr1---sn-test.googlevideo.com/videoplayback?itag=18" },
              },
            ],
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    throw new Error(`Unexpected fetch URL: ${url}`);
  };

  let offscreenCtrl = null;
  const env = createMockMv3Environment({
    async spawnOffscreenHook() {
      if (!offscreenCtrl) {
        offscreenCtrl = offscreenMod.createOffscreenController({
          chrome: env.chrome,
          fetchImpl: mockFetch,
          opfsStorage: opfs.storage,
          webLocks: opfs.locks,
          urlApi,
        });
      }
    },
  });
  const bg = backgroundMod.createBackgroundController({
    chrome: env.chrome,
    storage: storage.createExtensionStorage(),
    fetchImpl: mockFetch,
  });
  await bg.init();

  const progressBroadcasts = [];
  const port = env.chrome.runtime.connect({ name: protocol.SIDEPANEL_PORT_NAME });
  port.onMessage.addListener((msg) => {
    if (msg?.type === "PARSE_PROGRESS") {
      progressBroadcasts.push(msg);
    }
  });

  try {
    // 1) First parse runs context + prefetch in parallel and broadcasts 3 stages
    const r1 = await env.chrome.runtime.sendMessage({
      type: "PARSE_URL",
      url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    });
    assert.equal(r1.ok, true);
    assert.equal(sawConcurrentContextAndPrefetch, true, "GET /api/youtube/context and OFFSCREEN_YOUTUBE_PREFETCH must overlap in parallel");
    assert.equal(contextCalls, 1);
    assert.ok(oembedCalls >= 1);
    assert.deepEqual(
      progressBroadcasts.map((m) => m.stage),
      [1, 2, 3],
      "must emit 3-stage PARSE_PROGRESS notifications",
    );

    // 2) Second parse hits short-TTL context cache (0 extra /api/youtube/context calls)
    const r2 = await env.chrome.runtime.sendMessage({
      type: "PARSE_URL",
      url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    });
    assert.equal(r2.ok, true);
    assert.equal(contextCalls, 1, "second YouTube parse within TTL must reuse cached context");

    // 3) Third parse triggers 400 player_id expired on finalize -> invalidates cache, refreshes context once, retries & succeeds
    failNextFinalizeStale = true;
    const r3 = await env.chrome.runtime.sendMessage({
      type: "PARSE_URL",
      url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    });
    assert.equal(r3.ok, true);
    assert.equal(contextCalls, 2, "400 player_id failure must invalidate cache and re-fetch context once");
    assert.equal(finalizeCalls, 4, "1 + 1 + (1 failed + 1 retried)");
  } finally {
    port.disconnect();
    offscreenCtrl?.dispose();
    bg.dispose();
  }

  // [P2-5d] Generic mux copy must not hardcode "4K" across extension download pipeline & SidePanel
  for (const rel of [
    "src/extension/extensionDownload.ts",
    "src/extension/bg/downloadCoordinator.ts",
    "src/extension/components/SidePanelDownloads.vue",
  ]) {
    const src = readFileSync(join(FRONTEND_DIR, rel), "utf8");
    assert.equal(
      /正在准备\s*4K|4K\s*无损合流/.test(src),
      false,
      `${rel} must not hardcode 4K in generic mux progress copy`,
    );
  }
});

test("PR-B1 [G4 + Q5A]: Tier-2 refresh_url fallback in targetSpecBuilder/extensionDownload/specRefresher + SidePanelSettings disclosure", async () => {
  // 1) extractParseUrlFromRefreshUrl accepts valid /api/parse? and rejects unsafe inputs
  assert.equal(
    targetSpecBuilderMod.extractParseUrlFromRefreshUrl(
      "/api/parse?schema_version=1.0&url=https%3A%2F%2Fvimeo.com%2F987654",
    ),
    "https://vimeo.com/987654",
  );
  for (const bad of [
    "",
    null,
    undefined,
    "https://evil.test/api/parse?url=https://vimeo.com/1",
    "/api/resolve?url=https%3A%2F%2Fvimeo.com%2F1",
    "/api/parse?url=https%3A%2F%2Fvimeo.com%2F1#frag",
    "/api/parse?url=javascript:alert(1)",
  ]) {
    assert.equal(targetSpecBuilderMod.extractParseUrlFromRefreshUrl(bad), "");
  }

  // 2) Tier-2 media omitting item.resolve_url & source_url populates refreshUrl and extracts parseUrl
  const tier2Media = {
    platform: "vimeo",
    content_id: "987654",
    title: "Tier2 Refresh Fallback",
    generated_at: "2026-11-25T00:00:00Z",
    refresh_url: "/api/parse?schema_version=1.0&url=https%3A%2F%2Fvimeo.com%2F987654",
    items: [
      {
        id: "vimeo-item-1",
        type: "video",
        variants: [
          {
            id: "mp4-720",
            label: "720p",
            metadata: { width: 1280, height: 720, has_audio: true, extension: "mp4", mime_type: "video/mp4" },
            delivery: {
              kind: "file",
              sources: [
                {
                  id: "s1",
                  url: "https://vod-progressive.akamaized.net/exp=100/old-720.mp4",
                  expires_at: "2099-01-01T00:00:00Z",
                },
              ],
            },
          },
        ],
        default: {
          variant_id: "mp4-720",
          source_id: "s1",
          url: "https://vod-progressive.akamaized.net/exp=100/old-720.mp4",
          expires_at: "2099-01-01T00:00:00Z",
        },
      },
    ],
  };

  const options = uiTargetHelpersMod.buildSidePanelQualityOptions(
    tier2Media,
    tier2Media.items[0],
    "https://snap.dokitool.com",
  );
  const singleEnqueue = uiTargetHelpersMod.buildSingleDownloadEnqueueItem({
    media: tier2Media,
    item: tier2Media.items[0],
    option: options[0],
    settings: { ...storage.DEFAULT_EXTENSION_SETTINGS },
  });
  assert.equal(singleEnqueue.refreshContext?.resolveUrl, undefined);
  assert.equal(singleEnqueue.refreshContext?.refreshUrl, tier2Media.refresh_url);
  assert.equal(singleEnqueue.refreshContext?.parseUrl, "https://vimeo.com/987654");

  const bgItems = extensionDownloadMod.buildEnqueueItemsForMedia(tier2Media, {
    apiOrigin: "https://snap.dokitool.com",
  });
  assert.equal(bgItems.length, 1);
  assert.equal(bgItems[0].refreshContext?.resolveUrl, undefined);
  assert.equal(bgItems[0].refreshContext?.refreshUrl, tier2Media.refresh_url);
  assert.equal(bgItems[0].refreshContext?.parseUrl, "https://vimeo.com/987654");

  // 3) specRefresher falls back to refreshUrl when parseUrl & resolveUrl are absent, and preserves refreshUrl across refresh
  let parsedUrls = [];
  let resolveLazyCalls = 0;
  const refresher = specRefresherMod.createSpecRefresher({
    nowFn: () => Date.parse("2026-11-25T00:05:00Z"),
    async resolveLazyItemInternal() {
      resolveLazyCalls += 1;
      throw new Error("Tier-2 refresh must not call /api/resolve");
    },
    async parseSupportedUrlInternal(matched) {
      parsedUrls.push(matched.url);
      return {
        ...tier2Media,
        refresh_url: "/api/parse?schema_version=1.0&url=https%3A%2F%2Fvimeo.com%2F987654",
        items: [
          {
            ...tier2Media.items[0],
            variants: [
              {
                ...tier2Media.items[0].variants[0],
                delivery: {
                  kind: "file",
                  sources: [
                    {
                      id: "s1",
                      url: "https://vod-progressive.akamaized.net/exp=999/fresh-720.mp4",
                      expires_at: "2026-11-25T02:00:00Z",
                    },
                  ],
                },
              },
            ],
            default: {
              variant_id: "mp4-720",
              source_id: "s1",
              url: "https://vod-progressive.akamaized.net/exp=999/fresh-720.mp4",
              expires_at: "2026-11-25T02:00:00Z",
            },
          },
        ],
      };
    },
  });

  const specWithoutParseUrl = {
    ...singleEnqueue.spec,
    refreshContext: {
      parseUrl: "",
      platform: "vimeo",
      itemId: "vimeo-item-1",
      variantId: "mp4-720",
      refreshUrl: tier2Media.refresh_url,
      expiresAtMs: Date.parse("2026-11-25T00:00:10Z"),
    },
  };
  const refreshedSpec = await refresher.refreshSpecFromContext(
    specWithoutParseUrl,
    { ...storage.DEFAULT_EXTENSION_SETTINGS },
  );
  assert.equal(resolveLazyCalls, 0);
  assert.deepEqual(parsedUrls, ["https://vimeo.com/987654"]);
  assert.deepEqual(refreshedSpec.routes, [
    "https://vod-progressive.akamaized.net/exp=999/fresh-720.mp4",
  ]);
  assert.equal(refreshedSpec.refreshContext?.resolveUrl, undefined);
  assert.equal(refreshedSpec.refreshContext?.refreshUrl, tier2Media.refresh_url);
  assert.equal(refreshedSpec.refreshContext?.parseUrl, "https://vimeo.com/987654");

  // 4) Q5A + G1 disclosure renders in SidePanelSettings.vue
  const SidePanelSettings = await loadSidePanelSfc(
    "../src/extension/components/SidePanelSettings.vue",
  );
  const settingsView = mountSfcTree(SidePanelSettings, {
    open: true,
    settings: { ...storage.DEFAULT_EXTENSION_SETTINGS },
    connection: null,
  });
  try {
    await settingsView.flush();
    const disclosureNodes = settingsView.findAll(
      (n) => n.props?.["data-testid"] === "privacy-boundary-disclosure",
    );
    assert.equal(disclosureNodes.length, 1);
    const disclosureText = settingsView.textOf(disclosureNodes[0]);
    assert.match(disclosureText, /浏览器原生下载器/);
    assert.match(disclosureText, /1006–1008/);
  } finally {
    settingsView.unmount();
  }
});

