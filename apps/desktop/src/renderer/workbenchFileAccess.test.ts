import { test } from "node:test";
import assert from "node:assert/strict";
import {
  fileReadPlan,
  isFabricatedGeneratedPath,
  previewKind,
  toWorkbenchFileItem,
  userFacingFileError,
  usesProjectReadFile,
  workbenchItemKind,
} from "./workbenchFileAccess.ts";

test("generated artifacts never route through project:readFile", () => {
  const item = toWorkbenchFileItem({
    id: "art_logo2",
    name: "virphone-logo-2.png",
    path: "generated/virphone-logo-2.png",
    kind: "generated",
    source: "artifact",
    mimeType: "image/png",
  });
  assert.equal(item.kind, "artifact");
  assert.equal(item.artifactId, "art_logo2");
  assert.equal(item.path, undefined);
  assert.deepEqual(fileReadPlan(item), { via: "artifact", artifactId: "art_logo2" });
  assert.equal(usesProjectReadFile(item), false);
  assert.equal(previewKind(item.mimeType, item.name), "image");
});

test("workspace files still use the workspace provider", () => {
  const item = toWorkbenchFileItem({ name: "index.html", path: "public/index.html", kind: "project", source: "local" });
  assert.equal(item.kind, "workspace-file");
  assert.equal(fileReadPlan(item).via, "workspace");
  assert.equal(fileReadPlan(item).path, "public/index.html");
  assert.equal(usesProjectReadFile(item), true);
});

test("fabricated generated/ paths are never treated as workspace files", () => {
  assert.equal(isFabricatedGeneratedPath("generated/virphone-logo-2.png"), true);
  assert.equal(isFabricatedGeneratedPath("C:\\\\Users\\\\me\\\\generated\\\\virphone-logo-2.png"), true);
  assert.equal(isFabricatedGeneratedPath("src/generated.ts"), false);
  const plan = fileReadPlan({ kind: "workspace-file", path: "generated/virphone-logo.png" });
  assert.equal(plan.via, "none");
});

test("missing artifact bytes do not fall back to the project filesystem", () => {
  const item = toWorkbenchFileItem({ name: "gone.png", kind: "generated", source: "artifact" });
  assert.equal(fileReadPlan(item).via, "none");
  assert.equal(usesProjectReadFile(item), false);
});

test("PNG is image preview, not plaintext", () => {
  assert.equal(previewKind("image/png", "logo.png"), "image");
  assert.equal(previewKind(null, "logo.png"), "image");
  assert.equal(previewKind("text/plain", "notes.txt"), "text");
  assert.equal(previewKind("application/zip", "out.zip"), "binary");
});

test("Electron RPC errors stay out of the user-facing copy", () => {
  const msg = userFacingFileError(new Error("Error invoking remote method 'project:readFile': Error: ENOENT: no such file or directory"));
  assert.equal(msg, "Could not open this file.");
  assert.doesNotMatch(msg, /project:readFile|ENOENT/);
});

test("kind inference from artifact ids", () => {
  assert.equal(workbenchItemKind({ id: "art_abc12345", kind: "file" }), "artifact");
  assert.equal(workbenchItemKind({ kind: "upload" }), "upload");
  assert.equal(workbenchItemKind({ kind: "run" }), "run-artifact");
});
