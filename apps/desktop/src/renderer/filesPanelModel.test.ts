import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTree, changedByOrion, filterTree, formatBytes, locationCopy, previewFooter, resolveFilesLocation, toProjectRelative, typeLabel } from "./filesPanelModel.ts";

test("location: a real project on this computer is Local, even on a cloud backend", () => {
  assert.equal(resolveFilesLocation({ environment: "local", projectRoot: "C:\\Users\\me\\app", cloudBackend: true }), "local");
});

test("location: no project on a cloud backend is Cloud, never Local", () => {
  assert.equal(resolveFilesLocation({ environment: "local", projectRoot: null, cloudBackend: true }), "cloud");
  assert.equal(resolveFilesLocation({ environment: "local", projectRoot: "C:\\x\\@orvyn\\workspace", cloudBackend: true, builtInWorkspace: true }), "cloud");
  assert.equal(resolveFilesLocation({ environment: "cloud", projectRoot: "C:\\Users\\me\\app", cloudBackend: true }), "cloud");
});

test("location copy says where the files are and what ORION does there", () => {
  const local = locationCopy("local", { projectRoot: "C:\\Users\\me\\app", workerState: "ready" });
  assert.equal(local.title, "Your computer");
  assert.match(local.note, /directly on your computer/);
  assert.equal(locationCopy("local", { workerState: "offline" }).tone, "off");
  const cloud = locationCopy("cloud", {});
  assert.equal(cloud.title, "ORVYN Cloud");
  assert.match(cloud.note, /not your computer/);
});

test("ORION's changes: relative paths, one row per file, newest first", () => {
  const rows = changedByOrion([
    { path: "C:\\Users\\me\\app\\src\\a.ts", kind: "edited", additions: 2, deletions: 1 },
    { path: "hello.txt", kind: "created", additions: 1 },
    { path: "src/a.ts", kind: "edited", additions: 3 },
    { path: "logo.png", kind: "artifact" },
  ], "C:\\Users\\me\\app");
  assert.deepEqual(rows.map((r) => [r.path, r.status, r.additions]), [["src/a.ts", "edited", 5], ["hello.txt", "new", 1]]);
});

test("tree: folders first, nested, sorted", () => {
  const tree = buildTree([{ path: "b.txt", bytes: 3 }, { path: "src/z.ts" }, { path: "src/a.ts" }, { path: "a.md" }]);
  assert.deepEqual(tree.map((n) => n.name), ["src", "a.md", "b.txt"]);
  assert.deepEqual(tree[0].children!.map((n) => n.path), ["src/a.ts", "src/z.ts"]);
  assert.deepEqual(filterTree(tree, "z.t").map((n) => [n.name, n.children?.map((c) => c.name)]), [["src", ["z.ts"]]]);
});

test("helpers: relative paths, sizes, labels, footer", () => {
  assert.equal(toProjectRelative("C:/Users/me/app/x/y.js", "C:\\Users\\me\\app"), "x/y.js");
  assert.equal(formatBytes(12), "12 B");
  assert.equal(formatBytes(1945), "1.9 KB");
  assert.equal(typeLabel("hello.txt"), "Text");
  assert.equal(previewFooter("local", { type: "Text", bytes: 12, changed: { path: "hello.txt", name: "hello.txt", status: "new", additions: 1, deletions: 0 } }), "On your computer · Text · 12 B · created by ORION this run");
  assert.match(previewFooter("cloud", { type: "HTML" }), /^In ORVYN Cloud/);
});
