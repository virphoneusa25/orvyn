import { test } from "node:test";
import assert from "node:assert/strict";
import {
  fileReadPlan,
  isFabricatedGeneratedPath,
  matchArtifactId,
  needsArtifactNameLookup,
  previewFailureNote,
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

test("a generated filename resolves to the artifact id, not a disk path", () => {
  const id = matchArtifactId(
    [
      { name: "notes.txt", artifactId: "art_notes" },
      { name: "can-you-do-a-orvyn-logo.png", artifactId: "art_fb37609f728441cb" },
    ],
    "can-you-do-a-orvyn-logo.png"
  );
  assert.equal(id, "art_fb37609f728441cb");
  assert.equal(matchArtifactId([{ name: "other.png", id: "not-an-artifact" }], "can-you-do-a-orvyn-logo.png"), null);
  const item = { kind: "workspace-file", name: "can-you-do-a-orvyn-logo.png", path: "generated/can-you-do-a-orvyn-logo.png" };
  assert.equal(needsArtifactNameLookup(item), true);
  assert.equal(needsArtifactNameLookup({ kind: "workspace-file", name: "package.json", path: "package.json" }), false);
});

test("disk refusal copy is not the generic preview error", () => {
  assert.match(previewFailureNote("disk-refused"), /not a project file/);
  assert.match(previewFailureNote("artifact-missing"), /ArtifactService/);
  assert.doesNotMatch(previewFailureNote("read-failed"), /not a project file/);
});

test("kind inference from artifact ids", () => {
  assert.equal(workbenchItemKind({ id: "art_abc12345", kind: "file" }), "artifact");
  assert.equal(workbenchItemKind({ kind: "upload" }), "upload");
  assert.equal(workbenchItemKind({ kind: "run" }), "run-artifact");
});
