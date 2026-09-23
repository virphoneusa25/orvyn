import { test } from "node:test";
import assert from "node:assert/strict";
import { matchesFile, type ArtifactTarget } from "./contextOpen.ts";
import { isFabricatedGeneratedPath, fileReadPlan, toWorkbenchFileItem } from "./workbenchFileAccess.ts";
import { parseWorkbenchTab, fileTabId } from "./workbenchModel.ts";

test("Show in Files target carries artifactId, not a file: tab", () => {
  const target: ArtifactTarget = {
    tab: "files",
    fileName: "virphone-logo-2.png",
    artifactId: "art_logo2",
  };
  assert.equal(target.tab, "files");
  assert.ok(target.artifactId);
  assert.notEqual(parseWorkbenchTab("files").kind, "file");
  assert.equal(parseWorkbenchTab(fileTabId("generated/virphone-logo-2.png")).kind, "file");
  assert.equal(isFabricatedGeneratedPath("generated/virphone-logo-2.png"), true);
});

test("generated PNG Show-in-Files item never plans project:readFile", () => {
  const item = toWorkbenchFileItem({
    artifactId: "art_logo2",
    name: "virphone-logo-2.png",
    path: "generated/virphone-logo-2.png",
    kind: "generated",
    mimeType: "image/png",
  });
  assert.equal(fileReadPlan(item).via, "artifact");
  assert.equal(matchesFile(item.name, { fileName: "virphone-logo-2.png" }), true);
});
