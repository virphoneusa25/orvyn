import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { LocalStore } from "../persistence/LocalStore";
import { ArtifactService } from "../artifacts/ArtifactService";
import { MINIMAL_PNG, sha256Hex } from "../artifacts/bytes";
import { ImageService } from "./ImageService";
import { makeGenerateImageTool } from "../ai/tools/imageTool";
import { requirePersistedArtifacts } from "../artifacts/artifactContract";

class FakeImageModel {
  constructor(private items: { b64?: string; url?: string }[]) {}
  config = { id: "fake-image" };
  generateImage = async () => this.items;
}

function modelService(items: { b64?: string; url?: string }[]) {
  const provider = new FakeImageModel(items);
  return {
    registry: { get: () => provider },
    router: { resolve: () => provider },
  } as any;
}

test("generate_image persists PNG bytes, read-back matches, tool ok only with artifactId", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "orvyn-img-"));
  const store = new LocalStore("tenant-a", dir);
  const artifacts = new ArtifactService("tenant-a", store, dir);
  const images = new ImageService(modelService([{ b64: MINIMAL_PNG.toString("base64") }]), artifacts);
  try {
    const out = await images.generate({ prompt: "a virphone logo", filename: "virphone-logo.png" });
    assert.equal(out.images.length, 1);
    const img = out.images[0];
    assert.match(img.artifactId, /^art_/);
    assert.equal(img.filename, "virphone-logo.png");
    const rec = artifacts.getArtifact(img.artifactId);
    assert.equal(rec?.status, "ready");
    const { bytes } = await artifacts.read(img.artifactId);
    assert.equal(bytes.length, MINIMAL_PNG.length);
    assert.equal(sha256Hex(bytes), img.sha256);
    assert.deepEqual(bytes.subarray(0, 8), MINIMAL_PNG.subarray(0, 8));

    const tool = makeGenerateImageTool(undefined, modelService([{ b64: MINIMAL_PNG.toString("base64") }]), artifacts);
    const result = await tool.execute({ prompt: "logo", filename: "virphone-logo.png" });
    const gated = requirePersistedArtifacts("generate_image", result);
    assert.equal(gated.ok, true);
    assert.ok(gated.artifacts?.[0]?.artifactId);
    const payload = JSON.parse(String(gated.output));
    assert.equal(payload.status, "success");
    assert.ok(payload.artifactId);
  } finally {
    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("a Fireworks 404 falls through to the next image model", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "orvyn-img-"));
  const store = new LocalStore("tenant-a", dir);
  const artifacts = new ArtifactService("tenant-a", store, dir);
  const png = MINIMAL_PNG.toString("base64");
  const broken = {
    config: { id: "fw:accounts/fireworks/models/flux-kontext-pro", capabilities: { image: true, imageEditing: true } },
    generateImage: async () => { throw new Error("Fireworks image submit HTTP 404."); },
  };
  const backup = { config: { id: "ci:gpt-image-2", capabilities: { image: true, imageEditing: false } }, generateImage: async () => [{ b64: png }] };
  const images = new ImageService({
    registry: { list: () => [broken, backup], get: (id: string) => (id.startsWith("fw:") ? broken : backup) },
    router: { resolve: () => broken },
  } as any, artifacts);
  try {
    const out = await images.generate({ prompt: "ORVYN logo", filename: "orvyn-ai-logo.png" });
    assert.equal(out.model, "ci:gpt-image-2");
    assert.equal(out.images[0].filename.endsWith(".png"), true);
    assert.ok(out.images[0].artifactId);
  } finally {
    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("description-only provider output cannot succeed", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "orvyn-img-"));
  const store = new LocalStore("tenant-a", dir);
  const artifacts = new ArtifactService("tenant-a", store, dir);
  const images = new ImageService(modelService([{ }]), artifacts);
  await assert.rejects(images.generate({ prompt: "logo" }), /neither image bytes|text description/i);
  assert.equal(artifacts.listArtifacts().length, 0);
  const tool = makeGenerateImageTool(undefined, modelService([{}]), artifacts);
  const result = await tool.execute({ prompt: "logo" });
  assert.equal(result.ok, false);
  store.close();
  await fs.rm(dir, { recursive: true, force: true });
});

test("empty base64 cannot succeed", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "orvyn-img-"));
  const store = new LocalStore("tenant-a", dir);
  const artifacts = new ArtifactService("tenant-a", store, dir);
  const images = new ImageService(modelService([{ b64: "" }]), artifacts);
  await assert.rejects(images.generate({ prompt: "logo" }), /empty base64|neither image bytes/i);
  assert.equal(artifacts.listArtifacts().length, 0);
  store.close();
  await fs.rm(dir, { recursive: true, force: true });
});

test("second generate with same name does not overwrite", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "orvyn-img-"));
  const store = new LocalStore("tenant-a", dir);
  const artifacts = new ArtifactService("tenant-a", store, dir);
  const images = new ImageService(modelService([{ b64: MINIMAL_PNG.toString("base64") }]), artifacts);
  const a = await images.generate({ prompt: "logo", filename: "virphone-logo.png" });
  const b = await images.generate({ prompt: "logo", filename: "virphone-logo.png" });
  assert.notEqual(a.images[0].artifactId, b.images[0].artifactId);
  assert.notEqual(a.images[0].filename, b.images[0].filename);
  assert.equal(artifacts.listArtifacts({ kind: "generated" }).length, 2);
  store.close();
  await fs.rm(dir, { recursive: true, force: true });
});
