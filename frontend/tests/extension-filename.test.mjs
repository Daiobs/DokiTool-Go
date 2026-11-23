import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { build, stop } from "esbuild";

let sanitizer;
let uiHelpers;

before(async () => {
  const bundleMod = async (rel) => {
    const absEntry = fileURLToPath(new URL(rel, import.meta.url));
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
  };
  [sanitizer, uiHelpers] = await Promise.all([
    bundleMod("../src/extension/filenameSanitizer.ts"),
    bundleMod("../src/extension/uiTargetHelpers.ts"),
  ]);
});

after(() => {
  stop();
});

function hasLoneSurrogate(str) {
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = str.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i++;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

test("filenameSanitizer: blocks .. traversal, slashes, colons, Windows illegal chars, and ASCII control chars", () => {
  assert.equal(sanitizer.sanitizeSubfolderPrefix("../../etc/passwd"), "etc/passwd");
  assert.equal(sanitizer.sanitizeSubfolderPrefix("..\\..\\Windows\\System32"), "Windows/System32");
  assert.equal(sanitizer.sanitizeSubfolderPrefix("/.././../"), "");
  assert.equal(sanitizer.sanitizeSubfolderPrefix("  /DokiTool/./素材/../收藏/  "), "DokiTool/素材/收藏");

  const dirty = "a/b\\c:d*e?f\"g<h>i|j\x00\x07\x1f\x7fk";
  const cleaned = sanitizer.sanitizeFilenameSegment(dirty);
  assert.equal(cleaned, "a b cdefghijk");
  assert.doesNotMatch(cleaned, /[/\\:*?"<>|\x00-\x1f\x7f]/);

  const path = sanitizer.buildSafeDownloadPath({
    prefix: "/../../DokiTool/",
    subfolder: "..",
    stem: "../../etc/passwd:evil*?",
    ext: ".mp4",
  });
  assert.equal(path, "DokiTool/etc passwdevil.mp4");
  for (const segment of path.split("/")) {
    assert.notEqual(segment, "");
    assert.notEqual(segment, ".");
    assert.notEqual(segment, "..");
  }
});

test("filenameSanitizer: prefixes _ on Windows reserved device names with or without extensions", () => {
  for (const [input, expected] of [
    ["CON", "_CON"],
    ["con", "_con"],
    ["PRN", "_PRN"],
    ["aux", "_aux"],
    ["NUL", "_NUL"],
    ["nul.mp4", "_nul.mp4"],
    ["com1", "_com1"],
    ["COM9.avi", "_COM9.avi"],
    ["lpt1", "_lpt1"],
    ["lpt9.txt", "_lpt9.txt"],
  ]) {
    assert.equal(
      sanitizer.sanitizeFilenameSegment(input),
      expected,
      `sanitizeFilenameSegment(${input})`,
    );
  }

  assert.equal(
    sanitizer.buildSafeDownloadPath({ stem: "CON", ext: "mp4" }),
    "_CON.mp4",
  );
  assert.equal(
    sanitizer.buildSafeDownloadPath({ stem: "nul.mp4", ext: "mp4" }),
    "_nul.mp4",
  );
  assert.equal(
    sanitizer.buildSafeDownloadPath({ stem: "com1", ext: ".webm" }),
    "_com1.webm",
  );
  assert.equal(
    sanitizer.buildSafeDownloadPath({ stem: "lpt9.txt", ext: "txt" }),
    "_lpt9.txt",
  );
  assert.equal(
    sanitizer.buildSafeDownloadPath({
      prefix: "CON/aux",
      subfolder: "NUL",
      stem: "prn",
      ext: "jpg",
    }),
    "_CON/_aux/_NUL/_prn.jpg",
  );
});

test("filenameSanitizer: strips trailing dots and spaces on every folder and filename stem", () => {
  assert.equal(sanitizer.sanitizeFilenameSegment("hello world...   "), "hello world");
  assert.equal(sanitizer.sanitizeFilenameSegment("...   "), "download");
  assert.equal(sanitizer.sanitizeSubfolderPrefix("DokiTool. / SubFolder... "), "DokiTool/SubFolder");

  // Even when code-point truncation lands right after a dot or space, trailing dot/space is stripped
  const dotAtBoundary = "测".repeat(59) + ".溢出的尾巴";
  const folderSeg = sanitizer.sanitizeFilenameSegment(dotAtBoundary, {
    maxCodePoints: 60,
  });
  assert.equal(Array.from(folderSeg).length, 59);
  assert.equal(folderSeg.endsWith("."), false);

  const built = sanitizer.buildSafeDownloadPath({
    prefix: "Folder. ",
    subfolder: "Album... ",
    stem: "Clip Title..  ",
    ext: " .MP4 ",
  });
  assert.equal(built, "Folder/Album/Clip Title.mp4");
});

test("filenameSanitizer: truncates folder <= 60 and stem <= 100 Unicode code points without splitting surrogate pairs", () => {
  // Astral plane emojis (each 1 code point, 2 UTF-16 code units) + CJK ideographs
  const longEmojiFolder = "🎬🎵🔥🐉".repeat(20); // 80 code points
  const longEmojiStem = "🌸✨🎬测试作品𠀋".repeat(16); // 128 code points

  const path = sanitizer.buildSafeDownloadPath({
    prefix: longEmojiFolder,
    subfolder: longEmojiFolder,
    stem: longEmojiStem,
    ext: "mp4",
  });

  const [prefixSeg, subSeg, fileSeg] = path.split("/");
  assert.equal(hasLoneSurrogate(prefixSeg), false);
  assert.equal(hasLoneSurrogate(subSeg), false);
  assert.equal(hasLoneSurrogate(fileSeg), false);

  assert.equal(Array.from(prefixSeg).length, 60);
  assert.equal(Array.from(subSeg).length, 60);
  assert.ok(fileSeg.endsWith(".mp4"));
  const stemOnly = fileSeg.slice(0, -4);
  assert.equal(Array.from(stemOnly).length, 100);
});

test("filenameSanitizer: formats subfolder + 001 batch item indices cleanly", () => {
  assert.equal(
    sanitizer.buildSafeDownloadPath({
      prefix: "DokiTool",
      subfolder: "旅行实况图集",
      index: 1,
      ext: "jpg",
    }),
    "DokiTool/旅行实况图集/001.jpg",
  );

  assert.equal(
    sanitizer.buildSafeDownloadPath({
      subfolder: "B站多P合集",
      index: 12,
      stem: "第十二讲:架构设计",
      ext: ".mp4",
    }),
    "B站多P合集/012_第十二讲架构设计.mp4",
  );

  assert.equal(
    sanitizer.buildSafeDownloadPath({
      subfolder: "千张大图集",
      index: 7,
      totalCount: 1200,
      ext: "webp",
    }),
    "千张大图集/0007.webp",
  );
});

test("single-video resolveItemBaseName prioritizes media.title over raw mmexport item.title and avoids subfolder / 001_ prefix", () => {
  const mkSingleBili = (overrides = {}) => ({
    platform: "bilibili",
    content_id: "BV1mmExport01",
    title: "如何用 Go 构建高性能下载服务",
    author: { name: "硬核UP主" },
    groups: [
      {
        id: "parts",
        kind: "multipart",
        total_count: 1,
        item_ids: ["BV1mmExport01-p1"],
      },
    ],
    items: [
      {
        id: "BV1mmExport01-p1",
        type: "video",
        index: 1,
        title: "mmexport1794208831102.mp4",
        default: {
          variant_id: "v720",
          url: "https://upos-sz-mirrorcos.bilivideo.com/single.mp4",
        },
        variants: [
          {
            id: "v720",
            label: "720p",
            metadata: { width: 1280, height: 720, extension: "mp4", has_audio: true },
            delivery: {
              kind: "file",
              sources: [{ url: "https://upos-sz-mirrorcos.bilivideo.com/single.mp4" }],
            },
          },
        ],
      },
    ],
    ...overrides,
  });

  // 1) Main media.title wins over mmexport item.title; NO subfolder, NO 001_ prefix
  const media1 = mkSingleBili();
  assert.equal(uiHelpers.classifyMediaLayout(media1), "single");
  assert.equal(
    uiHelpers.resolveItemBaseName(media1, media1.items[0]),
    "如何用 Go 构建高性能下载服务",
  );
  const opts = uiHelpers.buildSidePanelQualityOptions(
    media1,
    media1.items[0],
    "https://snap.dokitool.com",
  );
  const enq1 = uiHelpers.buildSingleDownloadEnqueueItem({
    media: media1,
    item: media1.items[0],
    option: opts[0],
    settings: {
      apiBaseUrl: "https://snap.dokitool.com",
      bearerToken: "",
      qualityPreference: "best",
      batchSaveMode: "subfolder",
      subfolderPrefix: "",
      themeMode: "system",
    },
  });
  assert.equal(enq1.spec.filename, "如何用 Go 构建高性能下载服务.mp4");
  assert.equal(enq1.spec.filename.includes("/"), false);
  assert.equal(enq1.spec.filename.includes("001_"), false);
  assert.equal(enq1.spec.filename.includes("mmexport"), false);

  // 2) Fallback chain when media.title is empty: item.title -> author -> platform_contentId
  const media2 = mkSingleBili({ title: "" });
  assert.equal(
    uiHelpers.resolveItemBaseName(media2, media2.items[0]),
    "mmexport1794208831102.mp4",
  );
  const enq2 = uiHelpers.buildSingleDownloadEnqueueItem({
    media: media2,
    item: media2.items[0],
    option: opts[0],
    settings: {
      apiBaseUrl: "https://snap.dokitool.com",
      bearerToken: "",
      qualityPreference: "best",
      batchSaveMode: "subfolder",
      subfolderPrefix: "",
      themeMode: "system",
    },
  });
  assert.equal(enq2.spec.filename, "mmexport1794208831102.mp4");

  const media3 = mkSingleBili({
    title: "",
    items: [{ ...media1.items[0], title: "" }],
  });
  assert.equal(uiHelpers.resolveItemBaseName(media3, media3.items[0]), "硬核UP主");

  const media4 = mkSingleBili({
    title: "",
    author: undefined,
    items: [{ ...media1.items[0], title: "" }],
  });
  assert.equal(
    uiHelpers.resolveItemBaseName(media4, media4.items[0]),
    "bilibili_BV1mmExport01",
  );
});
