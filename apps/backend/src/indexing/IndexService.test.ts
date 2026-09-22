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

test("incremental index: unchanged file is not re-embedded", async () => {
  const root = project();
  try {
    const store = new InMemoryVectorStore();
    let embeds = 0;
    const embedder = new HashingEmbedder();
    const orig = embedder.embedBatch.bind(embedder);
    embedder.embedBatch = async (texts) => {
      embeds += texts.length;
      return orig(texts);
    };
    const svc = new IndexService(embedder, store, "hash", "tenant_a");
    const first = await svc.build(root);
    assert.equal(first.status, "ready");
    assert.ok((first.chunksIndexed ?? 0) > 0);
    const afterFirst = embeds;
    const second = await svc.build(root);
    assert.equal(second.status, "ready");
    assert.equal(embeds, afterFirst, "unchanged files must not re-embed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("delete and rename remove stale paths", async () => {
  const root = project();
  try {
    const store = new InMemoryVectorStore();
    const svc = new IndexService(new HashingEmbedder(), store, "hash", "tenant_a");
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
    rmSync(root, { recursive: true, force: true });
  }
});

test("tenant isolation: project ids differ across tenants with the same folder name", async () => {
  const root = project();
  try {
    const a = new IndexService(new HashingEmbedder(), new InMemoryVectorStore(), "hash", "tenant_a");
    const b = new IndexService(new HashingEmbedder(), new InMemoryVectorStore(), "hash", "tenant_b");
    const idA = a.bindProject(root);
    const idB = b.bindProject(root);
    assert.notEqual(idA, idB);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("secrets are never indexed", async () => {
  assert.equal(isSecretPath(".env"), true);
  const root = project();
  try {
    const store = new InMemoryVectorStore();
    const svc = new IndexService(new HashingEmbedder(), store, "hash", "tenant_a");
    await svc.build(root);
    const hits = await svc.search("SECRET=do-not-index", 8);
    assert.ok(!hits.some((h) => h.path.includes(".env")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("embedding failure leaves a previous good index usable as degraded/error", async () => {
  const root = project();
  try {
    const store = new InMemoryVectorStore();
    const embedder = new HashingEmbedder();
    const svc = new IndexService(embedder, store, "hash", "tenant_a");
    const ok = await svc.build(root);
    assert.equal(ok.status, "ready");
    embedder.embedBatch = async () => { throw new Error("embedder down"); };
    writeFileSync(join(root, "src", "new.ts"), "export const x = 1;\n");
    const again = await svc.build(root, { rebuild: true });
    assert.ok(again.status === "degraded" || again.status === "error");
    assert.ok(ok.chunksIndexed > 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
