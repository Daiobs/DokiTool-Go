import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PLATFORMS_PATH = new URL(
  "../../backend/config/platforms.json",
  import.meta.url,
);
const PLATFORMS_EXTRA_PATH = new URL(
  "../../backend/config/platforms_extra.json",
  import.meta.url,
);
const OUTPUT_PATH = new URL(
  "../src/generated/platform-catalog.json",
  import.meta.url,
);

export function resolveDisplayDomains(entry) {
  if (Array.isArray(entry?.display_domains) && entry.display_domains.length > 0) {
    return [...entry.display_domains];
  }
  if (Array.isArray(entry?.domains)) {
    return [...entry.domains];
  }
  return [];
}

export async function loadSingleSourcePlatformConfigs() {
  const [registryRaw, extraRaw] = await Promise.all([
    readFile(PLATFORMS_PATH, "utf8"),
    readFile(PLATFORMS_EXTRA_PATH, "utf8"),
  ]);
  const registry = JSON.parse(registryRaw);
  const extraConfig = JSON.parse(extraRaw);

  if (!Array.isArray(registry) || registry.length === 0) {
    throw new Error("backend/config/platforms.json must be a non-empty array");
  }
  if (
    !extraConfig ||
    typeof extraConfig !== "object" ||
    !Array.isArray(extraConfig.extra_platforms) ||
    extraConfig.extra_platforms.length === 0
  ) {
    throw new Error(
      "backend/config/platforms_extra.json must contain a non-empty extra_platforms array",
    );
  }
  return { registry, extraConfig };
}

export async function renderPlatformCatalogSnapshot() {
  const { registry, extraConfig } = await loadSingleSourcePlatformConfigs();
  const seenIds = new Set();
  const combined = [];

  for (const entry of [...registry, ...extraConfig.extra_platforms]) {
    if (!entry || typeof entry.id !== "string" || !entry.id) {
      throw new Error("Platform catalog entry is missing a valid id");
    }
    if (seenIds.has(entry.id)) {
      throw new Error(`Duplicate platform id across registries: ${entry.id}`);
    }
    const displayDomains = resolveDisplayDomains(entry);
    const exactDomains = Array.isArray(entry.exact_domains)
      ? entry.exact_domains
      : [];
    if (displayDomains.length === 0 && exactDomains.length === 0) {
      throw new Error(
        `Platform ${entry.id} lacks domains/display_domains/exact_domains`,
      );
    }
    seenIds.add(entry.id);
    combined.push({
      id: entry.id,
      name: entry.name,
      site_url: entry.site_url,
      ...(entry.icon ? { icon: entry.icon } : {}),
      capabilities: entry.capabilities,
    });
  }

  return (
    JSON.stringify(
      { schema_version: "1.0", code: "OK", data: { platforms: combined } },
      null,
      2,
    ) + "\n"
  );
}

export async function checkPlatformCatalogSnapshot(outputPath = OUTPUT_PATH) {
  const expected = await renderPlatformCatalogSnapshot();
  let current;
  try {
    current = await readFile(outputPath, "utf8");
  } catch (err) {
    return {
      ok: false,
      reason: `missing generated catalog at ${outputPath instanceof URL ? fileURLToPath(outputPath) : outputPath}: ${err.message}`,
      expected,
    };
  }
  if (current !== expected) {
    return {
      ok: false,
      reason:
        "frontend/src/generated/platform-catalog.json is out of date with backend/config/platforms.json + backend/config/platforms_extra.json; run `node frontend/scripts/generate-platform-catalog.mjs`",
      expected,
    };
  }
  return { ok: true, expected };
}

async function main(argv = process.argv.slice(2)) {
  const unknownArgs = argv.filter((arg) => arg !== "--check");
  if (unknownArgs.length > 0) {
    console.error(
      `Unknown argument(s): ${unknownArgs.join(", ")}. Usage: node frontend/scripts/generate-platform-catalog.mjs [--check]`,
    );
    process.exit(1);
  }
  const checkOnly = argv.includes("--check");
  if (checkOnly) {
    const result = await checkPlatformCatalogSnapshot();
    if (!result.ok) {
      console.error(`platform-catalog check FAILED: ${result.reason}`);
      process.exit(1);
    }
    const parsed = JSON.parse(result.expected);
    console.log(
      `platform-catalog check PASSED (${parsed.data.platforms.length} platforms)`,
    );
    return;
  }

  const rendered = await renderPlatformCatalogSnapshot();
  await mkdir(new URL("../src/generated/", import.meta.url), {
    recursive: true,
  });
  await writeFile(OUTPUT_PATH, rendered, "utf8");
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  await main();
}
