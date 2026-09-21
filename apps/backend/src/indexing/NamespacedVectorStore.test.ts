// Pins the project-namespacing contract: projects are isolated, rebuilds
// don't leak, incremental file invalidation works, and the store survives
// a restart (new instance over the same file).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { NamespacedVectorStore, projectNamespace } from "./NamespacedVectorStore";

function store(dir: string) {
  return new NamespacedVectorStore(join(dir, `vectors-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`));
}

test("namespaces: different roots produce different stable namespaces", () => {
  const a = projectNamespace("C:/Users/x/projA");
  const b = projectNamespace("C:\\Users\\x\\projB");
  assert.notEqual(a, b);
  assert.equal(projectNamespace("C:/Users/x/projA"), projectNamespace("C:\\Users\\x\\projA\\"), "separator/case normalization");
});

test("isolation: searching project A never returns project B's chunks", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orvyn-ns-"));
  try {
    const s = store(dir);
    s.activateProject("C:/projA");
    await s.upsert({ id: "a:1", vector: [1, 0], metadata: { relativePath: "a.ts" } });
    s.activateProject("C:/projB");
    await s.upsert({ id: "b:1", vector: [0, 1], metadata: { relativePath: "b.ts" } });
    const hitsB = await s.search([0, 1], 10);
    assert.equal(hitsB.length, 1);
    assert.equal(hitsB[0].metadata.relativePath, "b.ts");
    s.activateProject("C:/projA");
    const hitsA = await s.search([1, 0], 10);
    assert.equal(hitsA.length, 1);
    assert.equal(hitsA[0].metadata.relativePath, "a.ts");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("clear() only clears the ACTIVE project", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orvyn-ns-"));
  try {
    const s = store(dir);
    s.activateProject("C:/projA");
    await s.upsert({ id: "a:1", vector: [1], metadata: {} });
    s.activateProject("C:/projB");
    await s.upsert({ id: "b:1", vector: [1], metadata: {} });
    await s.clear(); // clears B only
    assert.equal(await s.size(), 0);
    s.activateProject("C:/projA");
    assert.equal(await s.size(), 1, "project A untouched");
    assert.ok(s.hasIndex("C:/projA"));
    assert.ok(!s.hasIndex("C:/projB"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("restart: a new store over the same file restores both projects", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orvyn-ns-"));
  const file = join(dir, "shared.json");
  try {
    const s1 = new NamespacedVectorStore(file);
    s1.activateProject("C:/projA");
    await s1.upsert({ id: "a:1", vector: [1, 0], metadata: { relativePath: "x.ts" } });
    s1.activateProject("C:/projB");
    await s1.upsert({ id: "b:1", vector: [0, 1], metadata: { relativePath: "y.ts" } });

    const s2 = new NamespacedVectorStore(file); // "restart"
    s2.activateProject("C:/projA");
    assert.equal(await s2.size(), 1, "project A restored after restart");
    assert.ok(s2.hasIndex());
    assert.deepEqual(s2.projectStats(), { chunks: 1, files: 1 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("incremental: invalidateFile removes only that file's chunks", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orvyn-ns-"));
  try {
    const s = store(dir);
    s.activateProject("C:/projA");
    await s.upsert({ id: "p:file1:c1", vector: [1], metadata: { relativePath: "file1.ts" } });
    await s.upsert({ id: "p:file2:c1", vector: [1], metadata: { relativePath: "file2.ts" } });
    await s.invalidateFile("file1.ts");
    assert.equal(await s.size(), 1, "only file2 remains");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
