import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build, stop } from "esbuild";
import {
  checkPlatformCatalogSnapshot,
  loadSingleSourcePlatformConfigs,
  resolveDisplayDomains,
} from "../scripts/generate-platform-catalog.mjs";

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND_ROOT = path.resolve(TESTS_DIR, "..");
const GENERATOR_SCRIPT = path.join(
  FRONTEND_ROOT,
  "scripts",
  "generate-platform-catalog.mjs",
);
const GENERATED_CATALOG_PATH = path.join(
  FRONTEND_ROOT,
  "src",
  "generated",
  "platform-catalog.json",
);

let urlMatcher;

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
  urlMatcher = await bundleTsModule("../src/extension/urlMatcher.ts");
});

after(() => {
  stop();
});

test("generate-platform-catalog.mjs --check passes on committed snapshot and rejects drift", async () => {
  const res = spawnSync(process.execPath, [GENERATOR_SCRIPT, "--check"], {
    cwd: FRONTEND_ROOT,
    encoding: "utf8",
  });
  assert.equal(
    res.status,
    0,
    `expected --check exit 0, got ${res.status}\nstdout: ${res.stdout}\nstderr: ${res.stderr}`,
  );
  assert.match(res.stdout, /PASSED \(14 platforms\)/);

  // Unknown CLI flag must fail closed.
  const badFlag = spawnSync(process.execPath, [GENERATOR_SCRIPT, "--bogus"], {
    cwd: FRONTEND_ROOT,
    encoding: "utf8",
  });
  assert.notEqual(badFlag.status, 0, "unknown CLI flag must exit non-zero");

  // Drift detection against a stale copy must fail cleanly without mutating disk catalog.
  const tempDir = await mkdtemp(path.join(tmpdir(), "dokitool-catalog-check-"));
  try {
    const staleFile = path.join(tempDir, "stale-platform-catalog.json");
    await writeFile(staleFile, '{"schema_version":"1.0","code":"OK","data":{"platforms":[]}}\n', "utf8");
    const driftResult = await checkPlatformCatalogSnapshot(staleFile);
    assert.equal(driftResult.ok, false);
    assert.match(driftResult.reason, /out of date/);

    const missingResult = await checkPlatformCatalogSnapshot(
      path.join(tempDir, "does-not-exist.json"),
    );
    assert.equal(missingResult.ok, false);
    assert.match(missingResult.reason, /missing generated catalog/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("single-source backend configs match generated platform-catalog.json with zero private field leakage", async () => {
  const { registry, extraConfig } = await loadSingleSourcePlatformConfigs();
  assert.equal(registry.length, 9, "frozen platforms.json must contain 9 core platforms");
  assert.deepEqual(
    extraConfig.extra_platforms.map((p) => p.id),
    ["x", "youtube", "instagram", "facebook", "tumblr"],
  );
  assert.deepEqual(extraConfig.exact_domain_additions, {
    zuiyou: ["share.xiaochuankeji.cn"],
  });

  // Trap 2: facebook must keep exact_domains distinct from display_domains.
  const fbExtra = extraConfig.extra_platforms.find((p) => p.id === "facebook");
  assert.ok(fbExtra);
  assert.deepEqual(fbExtra.domains, []);
  assert.deepEqual(fbExtra.exact_domains, [
    "www.facebook.com",
    "facebook.com",
    "m.facebook.com",
    "fb.watch",
  ]);
  assert.deepEqual(fbExtra.display_domains, ["facebook.com", "fb.watch"]);
  assert.deepEqual(resolveDisplayDomains(fbExtra), ["facebook.com", "fb.watch"]);

  const xExtra = extraConfig.extra_platforms.find((p) => p.id === "x");
  assert.deepEqual(resolveDisplayDomains(xExtra), [
    "x.com",
    "twitter.com",
    "t.co",
  ]);

  const diskCatalog = JSON.parse(await readFile(GENERATED_CATALOG_PATH, "utf8"));
  assert.equal(diskCatalog.schema_version, "1.0");
  assert.equal(diskCatalog.code, "OK");
  const expectedAll = [...registry, ...extraConfig.extra_platforms];
  assert.equal(diskCatalog.data.platforms.length, 14);
  assert.deepEqual(
    diskCatalog.data.platforms,
    expectedAll.map(({ id, name, site_url, icon, capabilities }) => ({
      id,
      name,
      site_url,
      ...(icon ? { icon } : {}),
      capabilities,
    })),
  );
  for (const entry of diskCatalog.data.platforms) {
    assert.equal("domains" in entry, false);
    assert.equal("exact_domains" in entry, false);
    assert.equal("display_domains" in entry, false);
    assert.equal("file" in entry, false);
    assert.equal("adapter" in entry, false);
  }
});

test("urlMatcher.ts PLATFORM_DOMAIN_SPECS stays in 100% parity with backend 14-platform configs", async () => {
  const { registry, extraConfig } = await loadSingleSourcePlatformConfigs();
  const additions = extraConfig.exact_domain_additions ?? {};
  const merged = [...registry, ...extraConfig.extra_platforms];

  assert.deepEqual(
    [...urlMatcher.SUPPORTED_PLATFORM_IDS],
    merged.map((p) => p.id),
  );
  assert.equal(urlMatcher.PLATFORM_DOMAIN_SPECS.length, 14);

  for (let i = 0; i < merged.length; i++) {
    const src = merged[i];
    const spec = urlMatcher.PLATFORM_DOMAIN_SPECS[i];
    assert.equal(spec.id, src.id);
    assert.equal(spec.label, src.name);

    const expectedDomains = Array.isArray(src.domains) ? src.domains : [];
    const expectedExact = [
      ...(Array.isArray(src.exact_domains) ? src.exact_domains : []),
      ...(Array.isArray(additions[src.id]) ? additions[src.id] : []),
    ];

    assert.deepEqual(
      spec.domains ? [...spec.domains] : [],
      expectedDomains,
      `domains drift for platform ${src.id}`,
    );
    assert.deepEqual(
      spec.exactDomains ? [...spec.exactDomains] : [],
      expectedExact,
      `exactDomains drift for platform ${src.id}`,
    );

    // Every configured suffix domain must match apex + subdomains and reject lookalikes.
    for (const domain of expectedDomains) {
      assert.equal(
        urlMatcher.matchSupportedPlatformUrl(`https://${domain}/item/123`)?.platform,
        src.id,
        `apex domain ${domain} must match ${src.id}`,
      );
      assert.equal(
        urlMatcher.matchSupportedPlatformUrl(`https://www.${domain}/item/123`)?.platform,
        src.id,
        `www subdomain of ${domain} must match ${src.id}`,
      );
      assert.equal(
        urlMatcher.matchSupportedPlatformUrl(`https://evil${domain}/item/123`),
        null,
        `lookalike prefix evil${domain} must be rejected`,
      );
      assert.equal(
        urlMatcher.matchSupportedPlatformUrl(`https://${domain}.evil.example/item/123`),
        null,
        `lookalike suffix ${domain}.evil.example must be rejected`,
      );
    }

    // Every configured exact domain must match itself ONLY and reject arbitrary subdomains.
    for (const exactHost of expectedExact) {
      assert.equal(
        urlMatcher.matchSupportedPlatformUrl(`https://${exactHost}/item/123`)?.platform,
        src.id,
        `exact host ${exactHost} must match ${src.id}`,
      );
      assert.equal(
        urlMatcher.matchSupportedPlatformUrl(`https://sub.${exactHost}/item/123`),
        null,
        `subdomain of exact host ${exactHost} must be rejected`,
      );
    }
  }
});

test("urlMatcher.ts intentional shortlink/subdomain rules and Facebook exact-host semantics", () => {
  // Intentional shortlink & subdomain rules across core platforms
  const shortlinkCases = [
    ["https://v.douyin.com/iRNBho6/", "douyin", false],
    ["https://v.kuaishou.com/abc123", "kuaishou", false],
    ["https://b23.tv/BV1xx411c7mD", "bilibili", false],
    ["https://xhslink.com/o/ATlAvhS71F8", "xiaohongshu", false],
    ["https://www.rednote.com/explore/65a1b2c3d4e5f6a7b8c9d0e1", "xiaohongshu", false],
    ["https://t.co/Zgzhvix8ES", "x", false],
    ["https://youtu.be/dQw4w9WgXcQ", "youtube", false],
    ["https://instagr.am/p/aye83DjauH/", "instagram", false],
    ["https://share.xiaochuankeji.cn/hybrid/share/post?pid=163566379", "zuiyou", false],
    ["https://fb.watch/vtkorrRM0p/", "facebook", false],
    ["https://maskofthedragon.tumblr.com/post/626907179849564160", "tumblr", false],
  ];
  for (const [sampleUrl, wantPlatform, wantFeed] of shortlinkCases) {
    const matched = urlMatcher.matchSupportedPlatformUrl(sampleUrl);
    assert.ok(matched, `expected ${sampleUrl} to match ${wantPlatform}`);
    assert.equal(matched.platform, wantPlatform);
    assert.equal(matched.isLikelyFeedOrHome, wantFeed);
  }

  // zuiyou exact-host rule: share.xiaochuankeji.cn only, never parent or subdomain
  for (const badZuiyou of [
    "https://xiaochuankeji.cn/hybrid/share/post?pid=163566379",
    "https://www.share.xiaochuankeji.cn/hybrid/share/post?pid=163566379",
    "https://sub.share.xiaochuankeji.cn/hybrid/share/post?pid=163566379",
  ]) {
    assert.equal(
      urlMatcher.matchSupportedPlatformUrl(badZuiyou),
      null,
      `${badZuiyou} must not match zuiyou`,
    );
  }

  // Trap 2: Facebook exact-host semantics — allowed exact hosts vs rejected subdomains
  for (const okFb of [
    "https://www.facebook.com/watch/?v=647537299265662",
    "https://facebook.com/watch/?v=647537299265662",
    "https://m.facebook.com/watch/?v=647537299265662",
    "https://fb.watch/vtkorrRM0p/",
  ]) {
    const matched = urlMatcher.matchSupportedPlatformUrl(okFb);
    assert.equal(matched?.platform, "facebook", `${okFb} must match facebook`);
  }

  for (const rejectedFb of [
    "https://developers.facebook.com/docs/video",
    "https://business.facebook.com/watch/?v=647537299265662",
    "https://graph.facebook.com/v18.0/video",
    "https://web.facebook.com/watch/?v=647537299265662",
    "https://l.facebook.com/l.php?u=https%3A%2F%2Fexample.com",
    "https://www.fb.watch/vtkorrRM0p/",
    "https://sub.fb.watch/vtkorrRM0p/",
  ]) {
    assert.equal(
      urlMatcher.matchSupportedPlatformUrl(rejectedFb),
      null,
      `${rejectedFb} must NOT be classified as core facebook`,
    );
  }
});
