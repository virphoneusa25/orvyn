import { test } from "node:test";
import assert from "node:assert/strict";
import { attachmentRole, fileKind, KIND_STYLE, previewMode } from "./fileKinds.ts";

test("files map to the right icons", () => {
  assert.equal(fileKind("hero.png"), "image");
  assert.equal(fileKind("index.html"), "html");
  assert.equal(fileKind("styles.css"), "css");
  assert.equal(fileKind("app.js"), "js");
  assert.equal(fileKind("main.tsx"), "ts");
  assert.equal(fileKind("data.json"), "json");
  assert.equal(fileKind("report.pdf"), "pdf");
  assert.equal(fileKind("blob", "image/webp"), "image");
  assert.equal(KIND_STYLE[fileKind("x.ts")].label, "TS");
  assert.equal(KIND_STYLE[fileKind("x.js")].label, "JS");
});

test("every previewable kind has a local renderer; binaries are download-only", () => {
  assert.equal(previewMode("image"), "image");
  assert.equal(previewMode("html"), "html");
  assert.equal(previewMode("pdf"), "pdf");
  assert.equal(previewMode("json"), "text");
  assert.equal(previewMode("zip"), null);
  assert.equal(previewMode("doc"), null);
});

test("what a chat sends to the model for an attachment", () => {
  assert.equal(attachmentRole("photo.jpg", "image/jpeg"), "image");
  assert.equal(attachmentRole("logo.svg", "image/svg+xml"), "text");
  assert.equal(attachmentRole("notes.md", "text/markdown"), "text");
  assert.equal(attachmentRole("deck.pptx", ""), "binary");
});
