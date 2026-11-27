#!/usr/bin/env node
/**
 * Unified auto-discovering unit-test runner for `frontend/tests/*.test.mjs`.
 *
 * Registers the zero-extra-dependency TypeScript ESM loader (`register-ts.mjs`)
 * and runs all unit test suites deterministically (`--test-concurrency=1`),
 * excluding `prerender.test.mjs` which requires a completed `dist/` build and
 * runs via `npm run build` / `npm run test:ssg`.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const frontendRoot = path.resolve(scriptDir, "..");
const testsDir = path.join(frontendRoot, "tests");

const EXCLUDED_TESTS = new Set(["prerender.test.mjs"]);

const testFiles = fs
  .readdirSync(testsDir, { withFileTypes: true })
  .filter(
    (entry) =>
      entry.isFile() &&
      entry.name.endsWith(".test.mjs") &&
      !EXCLUDED_TESTS.has(entry.name),
  )
  .map((entry) => path.posix.join("tests", entry.name))
  .sort();

if (testFiles.length === 0) {
  console.error("run-unit-tests: no test files discovered under frontend/tests/");
  process.exit(1);
}

const extraArgs = process.argv.slice(2);
const result = spawnSync(
  process.execPath,
  [
    "--import",
    "./tests/helpers/register-ts.mjs",
    "--test",
    "--test-concurrency=1",
    ...extraArgs,
    ...testFiles,
  ],
  {
    cwd: frontendRoot,
    stdio: "inherit",
  },
);

if (result.error) {
  console.error(`run-unit-tests: failed to spawn node: ${result.error.message}`);
  process.exit(1);
}

process.exit(result.status ?? (result.signal ? 1 : 0));
