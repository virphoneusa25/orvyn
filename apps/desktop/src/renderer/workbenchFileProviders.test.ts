import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ArtifactFileProvider,
  CloudFileProvider,
  LocalFileProvider,
  SandboxFileProvider,
  UploadFileProvider,
  composeWorkbenchFileTree,
  projectProviderFor,
  resolveProjectFetchRoot,
} from "./workbenchFileProviders.ts";

const locations = [
  { id: "project", files: [{ name: "package.json", path: "package.json", kind: "project" }] },
  { id: "generated", files: [{ id: "art1", name: "virphone-logo.png", path: "virphone-logo.png", kind: "generated" }] },
  { id: "uploads", files: [{ name: "requirements.pdf", path: "requirements.pdf", kind: "upload" }] },
  { id: "artifacts", files: [{ name: "test-results.json", path: "test-results.json", kind: "run" }] },
];

test("project provider follows the current execution environment", () => {
  assert.equal(projectProviderFor("local") instanceof LocalFileProvider, true);
  assert.equal(projectProviderFor("cloud") instanceof CloudFileProvider, true);
  assert.equal(projectProviderFor("sandbox") instanceof SandboxFileProvider, true);
  assert.equal(new LocalFileProvider().list({ environment: "cloud", locations }).length, 0);
  assert.equal(new CloudFileProvider().list({ environment: "cloud", locations })[0]?.name, "package.json");
  assert.equal(new SandboxFileProvider().list({ environment: "sandbox", locations })[0]?.source, "sandbox");
});

test("artifact and upload providers stay visible in every environment", () => {
  const arts = new ArtifactFileProvider().list({ environment: "cloud", locations });
  assert.ok(arts.some((f) => f.name === "virphone-logo.png"));
  assert.ok(arts.some((f) => f.name === "test-results.json"));
  const uploads = new UploadFileProvider().list({ environment: "sandbox", locations });
  assert.equal(uploads[0]?.source, "upload");
});

test("composeWorkbenchFileTree unifies project + generated + uploads", () => {
  const tree = composeWorkbenchFileTree({ environment: "local", locations });
  assert.equal(tree.hasProject, true);
  assert.ok(tree.sections.find((s) => s.id === "generated")?.files.some((f) => f.name === "virphone-logo.png"));
  assert.ok(tree.sections.find((s) => s.id === "uploads")?.files.some((f) => f.name === "requirements.pdf"));
});

test("cloud backend drops a Windows path it cannot see", () => {
  assert.equal(resolveProjectFetchRoot("C:\\\\Users\\\\me\\\\proj", true), null);
  assert.equal(resolveProjectFetchRoot("/workspace", false), "/workspace");
});
