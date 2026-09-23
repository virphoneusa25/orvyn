import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { LocalStore } from "../persistence/LocalStore";
import { ArtifactService, sanitizeArtifactName } from "./ArtifactService";
import { MINIMAL_PNG, sha256Hex } from "./bytes";
import { groundAssistantClaims, looksLikeFileDeliverableRequest } from "./claimValidator";
import { requirePersistedArtifacts } from "./artifactContract";

test("sanitizeArtifactName rejects paths and empty names", () => {
  assert.equal(sanitizeArtifactName("virphone-logo.png"), "virphone-logo.png");
  assert.equal(sanitizeArtifactName("../secret.png"), "secret.png");
  assert.throws(() => sanitizeArtifactName(".."), /file name/);
});

test("ArtifactService persist/list/read/delete, hash, files tree, restart", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "orvyn-art-"));
  const store = new LocalStore("tenant-a", dir);
  const svc = new ArtifactService("tenant-a", store, dir);
  try {
    const png = await svc.persistArtifact({
      name: "virphone-logo.png",
      kind: "generated",
      bytes: MINIMAL_PNG,
      mediaType: "image/png",
      sourceTool: "generate_image",
    });
    assert.match(png.artifactId, /^art_/);
    assert.equal(png.name, "virphone-logo.png");
    assert.equal(png.kind, "generated");
    assert.equal(png.sha256, sha256Hex(MINIMAL_PNG));
    assert.equal(png.size, MINIMAL_PNG.length);
    assert.ok(!JSON.stringify(svc.toPublic(png)).includes(png.diskPath ?? "nope-disk"));
    const { bytes } = await svc.read(png.artifactId);
    assert.equal(bytes.subarray(0, 8).equals(MINIMAL_PNG.subarray(0, 8)), true);
    const listed = svc.listArtifacts({ kind: "generated" });
    assert.equal(listed.length, 1);
    const tree = await svc.filesTree();
    const generated = tree.locations.find((l) => l.id === "generated");
    assert.ok(generated);
    assert.equal(generated!.files.some((f) => f.name === "virphone-logo.png" && f.id === png.artifactId && f.source === "artifact"), true);
    assert.equal(tree.locations.find((l) => l.id === "project")?.files.some((f) => f.name === "virphone-logo.png" || String(f.path).includes("generated/")), false);
    const recents = tree.locations.find((l) => l.id === "recents");
    assert.ok(recents?.files.some((f) => f.name === "virphone-logo.png"));
    const collision = await svc.persistArtifact({ name: "virphone-logo.png", kind: "generated", bytes: MINIMAL_PNG, mimeType: "image/png" });
    assert.equal(collision.name, "virphone-logo-2.png");
    const doc = await svc.persistArtifact({ name: "notes.md", kind: "document", content: "# Hello" });
    const read = await svc.read(doc.artifactId);
    assert.match(read.bytes.toString("utf-8"), /Hello/);
    store.close();
    const store2 = new LocalStore("tenant-a", dir);
    const svc2 = new ArtifactService("tenant-a", store2, dir);
    const again = await svc2.read(png.artifactId);
    assert.equal(again.bytes.length, MINIMAL_PNG.length);
    await svc2.deleteArtifact(png.artifactId);
    assert.equal(svc2.listArtifacts({ kind: "generated" }).length, 1);
    store2.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("zero-byte and bad PNG signature rejected", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "orvyn-art-"));
  const store = new LocalStore("tenant-a", dir);
  const svc = new ArtifactService("tenant-a", store, dir);
  try {
    await assert.rejects(svc.persistArtifact({ name: "empty.txt", content: "" }), /zero-byte/);
    await assert.rejects(
      svc.persistArtifact({ name: "fake.png", bytes: Buffer.from("not a png"), mimeType: "image/png" }),
      /not a PNG/
    );
  } finally {
    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("tenant isolation: tenant B cannot read tenant A bytes", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "orvyn-art-"));
  const storeA = new LocalStore("tenant-a", dir);
  const storeB = new LocalStore("tenant-b", dir);
  const a = new ArtifactService("tenant-a", storeA, dir);
  const b = new ArtifactService("tenant-b", storeB, dir);
  try {
    const rec = await a.persistArtifact({ name: "secret.txt", content: "tenant-a-only", kind: "generated" });
    assert.equal(b.getArtifact(rec.artifactId), null);
    await assert.rejects(b.read(rec.artifactId), /Unknown artifact/);
  } finally {
    storeA.close();
    storeB.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("persist read-back mismatch deletes the partial artifact", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "orvyn-art-"));
  const store = new LocalStore("tenant-a", dir);
  const svc = new ArtifactService("tenant-a", store, dir);
  try {
    const rec = await svc.persistArtifact({ name: "hello.txt", content: "hello world", kind: "generated" });
    const { bytes } = await svc.read(rec.artifactId);
    assert.equal(bytes.toString("utf-8"), "hello world");
    assert.equal(rec.status, "ready");
    await fs.rm(rec.diskPath!, { force: true });
    await assert.rejects(svc.read(rec.artifactId), /ENOENT|Unknown|read/i);
  } finally {
    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("storage unavailable cannot produce an artifactId", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "orvyn-art-"));
  const store = new LocalStore("tenant-a", dir);
  const svc = new ArtifactService("tenant-a", store, dir);
  try {
    const orig = svc.health.bind(svc);
    (svc as any).health = async () => ({ healthy: false, detail: "forced down" });
    await assert.rejects(svc.persistArtifact({ name: "x.txt", content: "hello" }), /unavailable/);
    assert.equal(svc.listArtifacts().length, 0);
    (svc as any).health = orig;
  } finally {
    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("ZIP persist has PK signature", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "orvyn-art-"));
  const store = new LocalStore("tenant-a", dir);
  const svc = new ArtifactService("tenant-a", store, dir);
  try {
    const zip = await svc.persistZip("site.zip", [{ name: "index.html", content: "<h1>hi</h1>" }]);
    assert.match(zip.artifactId, /^art_/);
    const { bytes } = await svc.read(zip.artifactId);
    assert.equal(bytes.subarray(0, 2).toString(), "PK");
  } finally {
    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("claim validator blocks generated claims without artifactId", () => {
  const blocked = groundAssistantClaims("Your Virphone logo has been generated as virphone-logo.png. You'll find it in Files → Generated.", []);
  assert.equal(blocked.blocked, true);
  assert.match(blocked.text, /No file was saved/);
  const ok = groundAssistantClaims("Saved virphone-logo.png.", [{ artifactId: "art_1", name: "virphone-logo.png", mimeType: "image/png" }]);
  assert.equal(ok.blocked, false);
  const invented = groundAssistantClaims("Download fake-name.png", [{ artifactId: "art_1", name: "virphone-logo.png" }]);
  assert.equal(invented.blocked, true);
  const sandbox = groundAssistantClaims(
    "Generated the PNG logo: download virphone-logo-2.png (sandbox/artifacts/art_a00bec51040e94710/download).",
    [{ artifactId: "art_a00bec51040e94710", name: "virphone-logo-2.png" }]
  );
  assert.equal(sandbox.blocked, true);
  assert.match(sandbox.text, /Files → Generated/);
  assert.doesNotMatch(sandbox.text, /sandbox\/artifacts/);
  assert.equal(looksLikeFileDeliverableRequest("Generate a simple VirPhone logo and provide it as a PNG."), true);
});

test("file-producing tools cannot return ok without artifactId", () => {
  const fail = requirePersistedArtifacts("generate_image", { ok: true, output: JSON.stringify({ status: "success" }) });
  assert.equal(fail.ok, false);
  const pass = requirePersistedArtifacts("generate_image", {
    ok: true,
    output: JSON.stringify({ status: "success", artifactId: "art_1", name: "virphone-logo.png", artifacts: [{ artifactId: "art_1", name: "virphone-logo.png" }] }),
  });
  assert.equal(pass.ok, true);
});
