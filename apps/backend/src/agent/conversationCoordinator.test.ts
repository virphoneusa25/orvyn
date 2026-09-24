import { test } from "node:test";
import assert from "node:assert/strict";
import { collectRunEvidence, introductionFor, progressFor } from "./conversationCoordinator";

test("any action task is introduced before tools, and a greeting is not", () => {
  assert.match(introductionFor("Fix the failing test") ?? "", /check the result/);
  assert.equal(introductionFor("hi", true), null);
});

test("progress follows evidence and never calls a localhost preview verified", () => {
  const empty = collectRunEvidence([]);
  const files = collectRunEvidence([{ type: "file.created", data: { path: "index.html" } }]);
  assert.match(progressFor(empty, files) ?? "", /index\.html/);
  const local = collectRunEvidence([
    { type: "file.created", data: { path: "index.html" } },
    { type: "preview.available", data: { url: "http://localhost:8080/" } },
  ]);
  assert.equal(local.previewUrl, undefined);
  const live = collectRunEvidence([
    { type: "file.created", data: { path: "index.html" } },
    { type: "preview.available", data: { url: "https://orvyn.example/api/v1/sites/1/" } },
  ]);
  assert.match(progressFor(files, live) ?? "", /orvyn\.example/);
  assert.equal(progressFor(live, live), null);
});
