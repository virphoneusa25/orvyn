import { test } from "node:test";
import assert from "node:assert/strict";
import { collectSessionOutputs, previewSiteId } from "./sessionState";

const done = (tool: string, file: string, operation: string, extra: Record<string, unknown> = {}) => ({
  type: "tool.completed", timestamp: 1, data: { tool, ...extra, envelope: { status: "success", evidence: [{ type: "file", file, operation }] } },
});

test("a session's outputs: changed files (newest op), artifacts, newest preview; verifier reads are not work", () => {
  const out = collectSessionOutputs([
    { id: "r1", events: [done("write_file", "index.html", "write"), done("write_file", "style.css", "write"), { type: "preview.available", timestamp: 2, data: { url: "http://h/api/v1/sites/abc/" } }] as any },
    { id: "r2", events: [done("edit_file", "index.html", "edit"), done("read_file", "notes.md", "read"), done("write_file", "x.txt", "write", { verifier: true }),
      { type: "artifact.created", timestamp: 3, data: { artifactId: "a1", name: "logo.png", mimeType: "image/png" } }] as any },
  ]);
  assert.deepEqual(out.files.map((f) => [f.path, f.operation, f.runId]), [["style.css", "write", "r1"], ["index.html", "edit", "r2"]]);
  assert.deepEqual(out.artifacts.map((a) => a.name), ["logo.png"]);
  assert.equal(out.preview?.url, "http://h/api/v1/sites/abc/");
  assert.equal(previewSiteId("http://h/api/v1/sites/abc/index.html"), "abc");
});
