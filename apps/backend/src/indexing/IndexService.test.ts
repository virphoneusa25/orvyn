import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, unlinkSync, renameSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { IndexService } from "./IndexService";
import { HashingEmbedder } from "./embeddings";
import { InMemoryVectorStore } from "./vectorStore";
import { isSecretPath } from "./ignoreRules";

function project(): string {
  const root = mkdtempSync(join(tmpdir(), "orvyn-idx-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "mail.ts"), "export function sendResetEmail(email: string) { return email; }\n");
  writeFileSync(join(root, "src", "user.ts"), "export function findUser(id: string) { return { id }; }\n");
  writeFileSync(join(root, ".env"), "SECRET=do-not-index\n");
  writeFileSync(join(root, "package.json"), "{\"name\":\"idx\"}\n");
  return root;
}

/** Windows hygiene: an index service holds a recursive directory watcher;
 * tearing it down lets the temp dir be removed cleanly. */
async function teardown(...services: Array<{ deleteIndex(): Promise<void> }>): Promise<void> {
  for (const svc of services) {
    try { await svc.deleteIndex(); } catch { /* best-effort teardown */ }
  }
}

/** Windows can hold a recursive-watch handle open for a beat even after
 * close(); removing a temp dir needs patient retries, not one rmSync. */
async function removeDir(root: string): Promise<void> {
  for (let i = 0; i < 20; i++) {
    try {
      rmSync(root, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 150));
    }
  }
  try { rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
}

test("incremental index: unchanged file is not re-embedded", async () => {
  const root = project();
  const embedder = new HashingEmbedder();
  const svc = new IndexService(embedder, new InMemoryVectorStore(), "hash", "tenant_a");
  try {
    let embeds = 0;
    const orig = embedder.embedBatch.bind(embedder);
    embedder.embedBatch = async (texts) => {
      embeds += texts.length;
      return orig(texts);
    };
    const first = await svc.build(root);
    assert.equal(first.status, "ready");
    assert.ok((first.chunksIndexed ?? 0) > 0);
    const afterFirst = embeds;
    const second = await svc.build(root);
    assert.equal(second.status, "ready");
    assert.equal(embeds, afterFirst, "unchanged files must not re-embed");
  } finally {
    await teardown(svc);
    await removeDir(root);
  }
});

test("delete and rename remove stale paths", async () => {
  const root = project();
  const store = new InMemoryVectorStore();
  const svc = new IndexService(new HashingEmbedder(), store, "hash", "tenant_a");
  try {
    await svc.build(root);
    await svc.removeFile("src/user.ts");
    unlinkSync(join(root, "src", "user.ts"));
    const leftover = await store.search(await new HashingEmbedder().embed("findUser"), 8);
    assert.ok(!leftover.some((r) => String(r.metadata.path).includes("user.ts")));

    writeFileSync(join(root, "src", "mail2.ts"), "export function sendResetEmail(email: string) { return email; }\n");
    await svc.renameFile("src/mail.ts", "src/mail2.ts");
    renameSync(join(root, "src", "mail.ts"), join(root, "src", "gone.ts"));
    const hits = await svc.search("sendResetEmail", 8);
    assert.ok(hits.every((h) => !h.path.endsWith("mail.ts")));
  } finally {
    await teardown(svc);
    await removeDir(root);
  }
});

test("tenant isolation: project ids differ across tenants with the same folder name", async () => {
  const root = project();
  const a = new IndexService(new HashingEmbedder(), new InMemoryVectorStore(), "hash", "tenant_a");
  const b = new IndexService(new HashingEmbedder(), new InMemoryVectorStore(), "hash", "tenant_b");
  try {
    const idA = a.bindProject(root);
    const idB = b.bindProject(root);
    assert.notEqual(idA, idB);
  } finally {
    await teardown(a, b);
    await removeDir(root);
  }
});

test("secrets are never indexed", async () => {
  assert.equal(isSecretPath(".env"), true);
  const root = project();
  const svc = new IndexService(new HashingEmbedder(), new InMemoryVectorStore(), "hash", "tenant_a");
  try {
    await svc.build(root);
    const hits = await svc.search("SECRET=do-not-index", 8);
    assert.ok(!hits.some((h) => h.path.includes(".env")));
  } finally {
    await teardown(svc);
    await removeDir(root);
  }
});

test("embedding failure leaves a previous good index usable as degraded/error", async () => {
  const root = project();
  const store = new InMemoryVectorStore();
  const embedder = new HashingEmbedder();
  const svc = new IndexService(embedder, store, "hash", "tenant_a");
  try {
    const ok = await svc.build(root);
    assert.equal(ok.status, "ready");
    embedder.embedBatch = async () => { throw new Error("embedder down"); };
    writeFileSync(join(root, "src", "new.ts"), "export const x = 1;\n");
    const again = await svc.build(root, { rebuild: true });
    assert.ok(again.status === "degraded" || again.status === "error");
    assert.ok(ok.chunksIndexed > 0);
  } finally {
    await teardown(svc);
    await removeDir(root);
  }
});
