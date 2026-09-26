import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { validateToolArguments } from "./toolPolicy";
import { classifyExecutedToolFailure, invalidArgumentsPayload, workspaceSnapshot } from "./toolFailure";

const writeSchema = {
  required: ["path", "content"],
  properties: { path: { type: "string" }, content: { type: "string" } },
};

test("write_file({}) is INVALID_ARGUMENTS for path and content", () => {
  const result = validateToolArguments("write_file", {}, writeSchema);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.errorType, "INVALID_ARGUMENTS");
  assert.deepEqual(result.missing, ["path", "content"]);
  assert.equal(result.retryable, true);
  const payload = JSON.parse(invalidArgumentsPayload({
    tool: "write_file",
    missing: result.missing,
    invalid: result.invalid,
    schema: writeSchema,
  }).modelText);
  assert.equal(payload.ok, false);
  assert.equal(payload.errorType, "INVALID_ARGUMENTS");
  assert.deepEqual(payload.missing, ["path", "content"]);
  assert.equal(payload.retryable, true);
  assert.deepEqual(payload.schema.required, ["path", "content"]);
});

test("a missing path is named even when content is present", () => {
  const result = validateToolArguments("write_file", { content: "Hello World" }, writeSchema);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.deepEqual(result.missing, ["path"]);
  assert.equal(result.errorType, "INVALID_ARGUMENTS");
});

test("schema failures are not execution failures", () => {
  const result = validateToolArguments("write_file", { path: "index.html" }, writeSchema);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.errorType, "INVALID_ARGUMENTS");
  assert.notEqual(classifyExecutedToolFailure(result.error), "INVALID_ARGUMENTS");
  assert.equal(classifyExecutedToolFailure("ENOENT: no such file or directory, open 'index.html'"), "RESOURCE_MISSING");
  assert.equal(classifyExecutedToolFailure("disk full"), "EXECUTION_FAILED");
  assert.equal(classifyExecutedToolFailure("EACCES: permission denied"), "PERMISSION_DENIED");
});

test("a missing workspace path reports the real directory listing", () => {
  const root = mkdtempSync(join(tmpdir(), "orvyn-ws-"));
  writeFileSync(join(root, "notes.txt"), "keep");
  const snap = workspaceSnapshot(root, "missing.txt");
  assert.equal(snap.exists, true);
  assert.deepEqual(snap.entries, ["notes.txt"]);
  assert.equal(snap.requestedExists, false);
  assert.equal(snap.requestedPath, "missing.txt");
});
