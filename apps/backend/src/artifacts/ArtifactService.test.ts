import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { LocalStore } from "../persistence/LocalStore";
import { ArtifactService, sanitizeArtifactName } from "./ArtifactService";

test("sanitizeArtifactName rejects paths and empty names", () => {
  assert.equal(sanitizeArtifactName("virphone-logo.png"), "virphone-logo.png");
  assert.equal(sanitizeArtifactName("../secret.png"), "secret.png");
  assert.throws(() => sanitizeArtifactName(".."), /file name/);
});

test("ArtifactService create/list/read/delete and files tree", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "orvyn-art-"));
  const store = new LocalStore("tenant-a", dir);
  const svc = new ArtifactService("tenant-a", store, dir);
  try {
    const png = await svc.create({
      name: "virphone-logo.png",
      kind: "generated",
      bytes: Buffer.from("89504e470d0a", "hex"),
      mediaType: "image/png",
    });
    assert.match(png.id, /^art_/);
    assert.equal(png.name, "virphone-logo.png");
    assert.equal(png.kind, "generated");
    const { bytes } = await svc.read(png.id);
    assert.equal(bytes.length > 0, true);
    const listed = svc.list({ kind: "generated" });
    assert.equal(listed.length, 1);
    const tree = await svc.filesTree();
    const generated = tree.locations.find((l) => l.id === "generated");
    assert.ok(generated);
    assert.equal(generated!.files.some((f) => f.name === "virphone-logo.png"), true);
    const doc = await svc.create({ name: "notes.md", kind: "document", content: "# Hello" });
    const read = await svc.read(doc.id);
    assert.match(read.bytes.toString("utf-8"), /Hello/);
    await svc.delete(png.id);
    assert.equal(svc.list({ kind: "generated" }).length, 0);
  } finally {
    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
