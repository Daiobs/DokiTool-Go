import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { collectTransitiveImportGraph } from "./helpers/staticImportGraph.mjs";

test("collectTransitiveImportGraph fails closed on unresolved relative imports", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dokitool-static-graph-"));
  try {
    const entry = path.join(tmpDir, "entry.ts");
    fs.writeFileSync(
      entry,
      'import { missing } from "./does-not-exist";\nexport const x = missing;\n',
      "utf8",
    );
    assert.throws(
      () => collectTransitiveImportGraph(entry),
      (err) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /Unresolved relative import "\.\/does-not-exist"/);
        assert.ok(err.message.includes(entry));
        return true;
      },
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("collectTransitiveImportGraph resolves Vite query suffixes and rejects missing query targets", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dokitool-static-graph-query-"));
  try {
    const dataFile = path.join(tmpDir, "template.txt");
    const entryOk = path.join(tmpDir, "ok.ts");
    const entryBad = path.join(tmpDir, "bad.ts");
    fs.writeFileSync(dataFile, "hello\n", "utf8");
    fs.writeFileSync(entryOk, 'import raw from "./template.txt?raw";\nexport default raw;\n', "utf8");
    fs.writeFileSync(entryBad, 'import raw from "./missing.txt?raw";\nexport default raw;\n', "utf8");

    const graph = collectTransitiveImportGraph(entryOk);
    assert.ok(graph.some((p) => p.endsWith("/template.txt")));
    assert.throws(
      () => collectTransitiveImportGraph(entryBad),
      /Unresolved relative import "\.\/missing\.txt\?raw"/,
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
