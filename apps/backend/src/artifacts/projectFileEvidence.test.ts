import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { makeEditFileTool, makeWriteFileTool } from "../ai/tools/fileTools";
import { verifyProjectFile } from "./projectFileEvidence";
import { groundAssistantClaims } from "./claimValidator";

test("a valid SVG project write has durable evidence and can be claimed", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "orvyn-project-evidence-"));
  try {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg>';
    const result = await makeWriteFileTool(root).execute({ path: "public/virphone-hero.svg", content: svg });
    assert.equal(result.ok, true);
    assert.equal(result.projectFileEvidence?.path, "public/virphone-hero.svg");
    assert.equal(result.projectFileEvidence?.size, Buffer.byteLength(svg));
    assert.equal((await fs.readFile(path.join(root, "public/virphone-hero.svg"), "utf-8")), svg);
    const claim = groundAssistantClaims("I created public/virphone-hero.svg", [], [], [result.projectFileEvidence!]);
    assert.equal(claim.blocked, false);
    const edit = await makeEditFileTool(root).execute({ path: "public/virphone-hero.svg", old_string: 'r="4"', new_string: 'r="3"' });
    assert.equal(edit.ok, true);
    assert.notEqual(edit.projectFileEvidence?.sha256, result.projectFileEvidence?.sha256);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("empty and malformed SVG writes cannot report success", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "orvyn-project-evidence-"));
  try {
    const tool = makeWriteFileTool(root);
    assert.equal((await tool.execute({ path: "public/empty.svg", content: "" })).ok, false);
    assert.equal((await tool.execute({ path: "public/bad.svg", content: "<svg>broken" })).ok, false);
    await fs.writeFile(path.join(root, "valid.svg"), '<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    await assert.rejects(verifyProjectFile(root, "valid.svg", Buffer.from("different")), /mismatch/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
