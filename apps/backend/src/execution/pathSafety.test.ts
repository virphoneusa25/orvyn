import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { isContained, resolveSafePath, resolveSafeRealpath } from "./pathSafety";

const ROOT = path.resolve("/tmp/orvyn-project");

test("resolveSafePath allows workspace-relative files", () => {
  const p = resolveSafePath(ROOT, "src/app.ts");
  assert.equal(p, path.resolve(ROOT, "src/app.ts"));
});

test("resolveSafePath blocks .. traversal and dotted escapes", () => {
  assert.throws(() => resolveSafePath(ROOT, "../etc/passwd"), /escapes/);
  assert.throws(() => resolveSafePath(ROOT, "foo/../../etc/passwd"), /escapes/);
  assert.throws(() => resolveSafePath(ROOT, "..\\..\\Windows\\System32"), /escapes/);
});

test("resolveSafePath blocks unauthorized absolute paths", () => {
  assert.throws(() => resolveSafePath(ROOT, "/etc/passwd"), /outside|escapes/);
  if (process.platform === "win32") {
    assert.throws(() => resolveSafePath("C:\\Users\\me\\proj", "C:\\Windows\\System32"), /outside|escapes/);
  }
});

test("isContained is slash-safe", () => {
  assert.equal(isContained("/a/b", "/a/b/c"), true);
  assert.equal(isContained("/a/b", "/a/b"), true);
  assert.equal(isContained("/a/b", "/a/be"), false);
  assert.equal(isContained("/a/b", "/a"), false);
});

test("resolveSafeRealpath refuses a symlink that leaves the workspace", async () => {
  if (process.platform === "win32") return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orvyn-path-"));
  const inside = path.join(dir, "inside");
  fs.mkdirSync(inside);
  const link = path.join(inside, "escape");
  try {
    fs.symlinkSync("/tmp", link);
  } catch {
    return;
  }
  await assert.rejects(() => resolveSafeRealpath(inside, "escape/passwd"), /link|escapes/);
});
