// Tests for the Qdrant-first / local-fallback architecture. Qdrant is not
// available in the test environment (no server running), so these tests
// exercise the ResilientVectorStore's fallback behavior — the contract
// that matters for "ORVYN must work without cloud."

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { ResilientVectorStore } from "./ResilientVectorStore";
import { NamespacedVectorStore } from "./NamespacedVectorStore";

// A VectorStore that always fails — simulates Qdrant being unreachable.
class UnavailableStore {
  readonly isHealthy = false;
  async upsert(): Promise<void> { throw new Error("Qdrant unavailable"); }
  async search(): Promise<never[]> { throw new Error("Qdrant unavailable"); }
  async delete(): Promise<void> { throw new Error("Qdrant unavailable"); }
  async clear(): Promise<void> { throw new Error("Qdrant unavailable"); }
  async size(): Promise<number> { throw new Error("Qdrant unavailable"); }
}

// A working in-memory store — simulates the local fallback.
class WorkingStore {
  private data = new Map<string, any>();
  async upsert(r: any): Promise<void> { this.data.set(r.id, r); }
  async search(q: number[], topK: number) {
    return [...this.data.values()]
      .map((r) => ({ id: r.id, score: r.vector[0] * q[0], metadata: r.metadata }))
      .sort((a: any, b: any) => b.score - a.score)
      .slice(0, topK);
  }
  async delete(id: string): Promise<void> { this.data.delete(id); }
  async clear(): Promise<void> { this.data.clear(); }
  async size(): Promise<number> { return this.data.size; }
}

test("resilient: falls back to local when Qdrant is unavailable", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orvyn-rv-"));
  try {
    const local = new NamespacedVectorStore(join(dir, "v.json"));
    local.activateProject("C:/proj");
    const store = new ResilientVectorStore(new UnavailableStore() as any, local);

    // Upsert goes through despite Qdrant being down
    await store.upsert({ id: "chunk1", vector: [0.9], metadata: { relativePath: "a.ts" } });
    const hits = await store.search([0.9], 5);
    assert.equal(hits.length, 1, "search served by local fallback");
    assert.equal(hits[0].metadata.relativePath, "a.ts");
    assert.equal(await store.size(), 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resilient: prefers primary when it works", async () => {
  const primary = new WorkingStore();
  const fallback = new WorkingStore();
  const store = new ResilientVectorStore(primary as any, fallback as any);

  await store.upsert({ id: "x", vector: [1], metadata: { via: "primary" } });
  assert.equal(await primary.size(), 1, "went to primary");
  assert.equal(await fallback.size(), 0, "fallback untouched");
});

test("resilient: transient failure degrades for that call only, recovers next", async () => {
  const primary = new WorkingStore();
  const fallback = new WorkingStore();
  const store = new ResilientVectorStore(primary as any, fallback as any);

  // Normal: goes to primary
  await store.upsert({ id: "a", vector: [1], metadata: { src: "p" } });
  assert.equal(await primary.size(), 1);

  // Simulate primary going down: primary.search throws.
  // The resilient store catches and serves from fallback (which has its own copy).
  await fallback.upsert({ id: "a", vector: [1], metadata: { src: "f" } });
  const origSearch = primary.search.bind(primary);
  (primary as any).search = async () => { throw new Error("transient"); };
  const hits = await store.search([1], 5);
  assert.equal(hits.length, 1, "served by fallback during transient failure");
  assert.equal(hits[0].metadata.src, "f", "came from fallback");

  // Primary recovers: next search goes back to primary.
  (primary as any).search = origSearch;
  const recovered = await store.search([1], 5);
  assert.equal(recovered.length, 1, "served by primary after recovery");
  assert.equal(recovered[0].metadata.src, "p", "came from primary");
});

test("project isolation: same file in two projects searches independently", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orvyn-iso-"));
  try {
    const store = new NamespacedVectorStore(join(dir, "v.json"));
    store.activateProject("C:/projA");
    await store.upsert({ id: "a:util.ts:1", vector: [1, 0], metadata: { relativePath: "util.ts", project: "A" } });
    store.activateProject("C:/projB");
    await store.upsert({ id: "b:util.ts:1", vector: [1, 0], metadata: { relativePath: "util.ts", project: "B" } });

    store.activateProject("C:/projA");
    const hitsA = await store.search([1, 0], 10);
    assert.equal(hitsA.length, 1);
    assert.equal(hitsA[0].metadata.project, "A");

    store.activateProject("C:/projB");
    const hitsB = await store.search([1, 0], 10);
    assert.equal(hitsB.length, 1);
    assert.equal(hitsB[0].metadata.project, "B");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("restart: local index survives a new store instance", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orvyn-rst-"));
  const file = join(dir, "v.json");
  try {
    const s1 = new NamespacedVectorStore(file);
    s1.activateProject("C:/proj");
    await s1.upsert({ id: "persist:1", vector: [1], metadata: { relativePath: "x.ts" } });

    const s2 = new NamespacedVectorStore(file);
    s2.activateProject("C:/proj");
    assert.equal(await s2.size(), 1, "index restored after restart");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
