import assert from "node:assert/strict";
import test from "node:test";
import { artifactsFromEvents, extractableDocument, generatingFilesFromEvents, wrapFileForModel } from "./fileStream.ts";

test("office and PDF drops are extracted, not sent as name-only stubs", () => {
  assert.equal(extractableDocument("brief.pdf"), true);
  assert.equal(extractableDocument("notes.docx"), true);
  assert.equal(extractableDocument("budget.xlsx"), true);
  assert.equal(extractableDocument("notes.ts"), false);
});

test("dropped text is wrapped in START/END FILE markers once", () => {
  const once = wrapFileForModel("app.ts", "export const n = 1;");
  assert.match(once, /START FILE: app.ts/);
  assert.match(once, /END FILE: app.ts/);
  assert.equal(wrapFileForModel("app.ts", once), once);
});

test("artifact.created events become downloadable file cards", () => {
  const files = artifactsFromEvents([
    { type: "artifact.created", data: { artifactId: "a1", name: "report.pdf", mimeType: "application/pdf" } },
    { type: "artifact.created", data: { artifactId: "a1", name: "report.pdf" } },
    { type: "image.generated", data: { id: "img1", filename: "hero.png", mediaType: "image/png" } },
  ]);
  assert.deepEqual(files.map((f) => f.artifactId), ["a1", "img1"]);
});

test("a create_document tool shows a generating card until the artifact lands", () => {
  const started = generatingFilesFromEvents([
    { type: "tool.started", data: { callId: "c1", tool: "create_document", args: { name: "report.pdf" } } },
  ]);
  assert.deepEqual(started, [{ name: "report.pdf" }]);
  const done = generatingFilesFromEvents([
    { type: "tool.started", data: { callId: "c1", tool: "create_document", args: { name: "report.pdf" } } },
    { type: "artifact.created", data: { artifactId: "a1", name: "report.pdf", mimeType: "application/pdf" } },
  ]);
  assert.deepEqual(done, []);
});
