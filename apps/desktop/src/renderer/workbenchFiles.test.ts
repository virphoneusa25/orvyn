import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mergeFileSections,
  searchFileTree,
  shouldShowBadge,
  projectSourceForEnvironment,
  isBinaryName,
} from "./workbenchFiles.ts";

test("File tree unifies project, generated artifacts, and uploads", () => {
  const tree = mergeFileSections(
    [
      { id: "project", files: [{ name: "package.json", path: "package.json", kind: "project" }] },
      { id: "generated", files: [{ id: "art1", name: "virphone-logo.png", path: "virphone-logo.png", kind: "generated" }] },
      { id: "uploads", files: [{ name: "requirements.pdf", path: "requirements.pdf", kind: "upload" }] },
    ],
    "cloud",
    [{ name: "report.pdf", path: "report.pdf", source: "artifact", kind: "artifact" }]
  );
  assert.equal(tree.hasProject, true);
  assert.equal(projectSourceForEnvironment("cloud"), "cloud");
  const generated = tree.sections.find((s) => s.id === "generated")!;
  assert.ok(generated.files.some((f) => f.name === "virphone-logo.png"));
  assert.ok(generated.files.some((f) => f.name === "report.pdf"));
  assert.equal(searchFileTree(tree, "logo").length, 1);
  assert.equal(isBinaryName("virphone-logo.png"), true);
});

test("live extras with artifactId stay in Generated, never as project paths", () => {
  const tree = mergeFileSections(
    [{ id: "project", files: [] }],
    "local",
    [{ id: "art_logo2", artifactId: "art_logo2", name: "virphone-logo-2.png", path: "virphone-logo-2.png", source: "artifact", kind: "generated", mediaType: "image/png" }]
  );
  const generated = tree.sections.find((s) => s.id === "generated")!;
  assert.equal(generated.files[0]?.artifactId, "art_logo2");
  assert.equal(tree.sections.find((s) => s.id === "project")!.files.length, 0);
});

test("empty project still lists generated and uploads", () => {
  const tree = mergeFileSections(
    [
      { id: "generated", files: [{ name: "out.png", path: "out.png", kind: "generated" }] },
      { id: "uploads", files: [] },
    ],
    "local"
  );
  assert.equal(tree.hasProject, false);
  assert.equal(tree.sections.find((s) => s.id === "generated")!.files.length, 1);
});

test("source badges stay quiet inside their own section", () => {
  assert.equal(shouldShowBadge("generated", "GENERATED", false), false);
  assert.equal(shouldShowBadge("uploads", "UPLOAD", false), false);
  assert.equal(shouldShowBadge("project", "CLOUD", true), true);
});
