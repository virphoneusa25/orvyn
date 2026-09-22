import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { buildProjectSnapshot, snapshotDiff } from "./projectSnapshot";

test("snapshot hashes files and diffs incremental changes", async () => {
  const root = mkdtempSync(join(tmpdir(), "orvyn-snap-"));
  try {
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n");
    writeFileSync(join(root, "src", "b.ts"), "export const b = 2;\n");
    const first = await buildProjectSnapshot("tenant_a", root, { projectId: "website" });
    assert.equal(first.tenantId, "tenant_a");
    assert.equal(first.projectId, "website");
    assert.ok(first.files.some((f) => f.path === "src/a.ts"));

    writeFileSync(join(root, "src", "a.ts"), "export const a = 2;\n");
    writeFileSync(join(root, "src", "c.ts"), "export const c = 3;\n");
    const second = await buildProjectSnapshot("tenant_a", root, { projectId: "website" });
    const diff = snapshotDiff(first, second);
    assert.equal(diff.changed.length, 1);
    assert.equal(diff.changed[0].path, "src/a.ts");
    assert.equal(diff.added.length, 1);
    assert.equal(diff.added[0].path, "src/c.ts");
    assert.ok(diff.unchanged.some((f) => f.path === "src/b.ts"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
