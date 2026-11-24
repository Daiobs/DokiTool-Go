#!/usr/bin/env node
import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";

const TARGET_EXT_RE = /\.(?:js|css|svg)$/i;

export async function precompressAssets(assetsDir) {
  const entries = await readdir(assetsDir, { withFileTypes: true });
  const files = entries
    .filter((ent) => ent.isFile() && TARGET_EXT_RE.test(ent.name))
    .map((ent) => ent.name)
    .sort();

  let rawTotal = 0;
  let brCount = 0;
  let brTotal = 0;
  let gzCount = 0;
  let gzTotal = 0;

  for (const name of files) {
    const filePath = path.join(assetsDir, name);
    const raw = await readFile(filePath);
    rawTotal += raw.length;

    const brPath = `${filePath}.br`;
    const brData = brotliCompressSync(raw, {
      params: {
        [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_TEXT,
        [constants.BROTLI_PARAM_QUALITY]: 11,
        [constants.BROTLI_PARAM_SIZE_HINT]: raw.length,
      },
    });
    if (brData.length < raw.length) {
      await writeFile(brPath, brData);
      brCount += 1;
      brTotal += brData.length;
    } else {
      await rm(brPath, { force: true });
    }

    const gzPath = `${filePath}.gz`;
    const gzData = gzipSync(raw, { level: 9 });
    if (gzData.length < raw.length) {
      await writeFile(gzPath, gzData);
      gzCount += 1;
      gzTotal += gzData.length;
    } else {
      await rm(gzPath, { force: true });
    }
  }

  return {
    scanned: files.length,
    rawTotal,
    brCount,
    brTotal,
    gzCount,
    gzTotal,
  };
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  const assetsDir = fileURLToPath(new URL("../dist/assets", import.meta.url));
  const summary = await precompressAssets(assetsDir);
  console.log(
    `Precompressed ${summary.scanned} assets (${summary.rawTotal} B raw): ${summary.brCount} .br (${summary.brTotal} B), ${summary.gzCount} .gz (${summary.gzTotal} B).`,
  );
}
