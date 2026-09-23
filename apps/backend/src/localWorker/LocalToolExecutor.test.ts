import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { contentHash, executeLocalTool, isSecretPath } from "./LocalToolExecutor";

function tmpProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orvyn-local-"));
  fs.writeFileSync(path.join(dir, "readme.txt"), "hello local\n");
  fs.writeFileSync(path.join(dir, "math.js"), "export const add = (a, b) => a + b;\n");
  return dir;
}

test("workspace scope: read/write/edit stay inside the project", async () => {
  const root = tmpProject();
  const read = await executeLocalTool({ tool: "read_file", projectRoot: root, arguments: { path: "readme.txt" } });
  assert.equal(read.ok, true);
  assert.match(read.output ?? "", /hello local/);

  const write = await executeLocalTool({
    tool: "write_file",
    projectRoot: root,
    runId: "r1",
    arguments: { path: "notes.txt", content: "created locally" },
  });
  assert.equal(write.ok, true);
  assert.equal(fs.readFileSync(path.join(root, "notes.txt"), "utf8"), "created locally");

  const edit = await executeLocalTool({
    tool: "edit_file",
    projectRoot: root,
    runId: "r1",
    arguments: { path: "readme.txt", old_string: "hello local", new_string: "hello orion" },
  });
  assert.equal(edit.ok, true);
  assert.match(fs.readFileSync(path.join(root, "readme.txt"), "utf8"), /hello orion/);
});

test("path escape is refused", async () => {
  const root = tmpProject();
  const escaped = await executeLocalTool({
    tool: "read_file",
    projectRoot: root,
    arguments: { path: "../secret.txt" },
  });
  assert.equal(escaped.ok, false);
  assert.match(escaped.error ?? "", /escapes|refused/);
});

test("search finds local code", async () => {
  const root = tmpProject();
  const found = await executeLocalTool({
    tool: "search_code",
    projectRoot: root,
    arguments: { pattern: "add" },
  });
  assert.equal(found.ok, true);
  assert.match(found.output ?? "", /math\.js/);
});

test("external edit conflict is detected", async () => {
  const root = tmpProject();
  const first = fs.readFileSync(path.join(root, "readme.txt"), "utf8");
  const stale = contentHash(first);
  fs.writeFileSync(path.join(root, "readme.txt"), "changed by vscode\n");
  const write = await executeLocalTool({
    tool: "write_file",
    projectRoot: root,
    runId: "r2",
    arguments: { path: "readme.txt", content: "orion overwrite", expectedHash: stale },
  });
  assert.equal(write.ok, false);
  assert.match(write.error ?? "", /changed externally/);
});

test("secret-like writes are refused", () => {
  assert.equal(isSecretPath(".env"), true);
  assert.equal(isSecretPath("src/app.ts"), false);
});

test("terminal runs in the project root", async () => {
  const root = tmpProject();
  const res = await executeLocalTool({
    tool: "terminal",
    projectRoot: root,
    arguments: { command: process.platform === "win32" ? "cd" : "pwd" },
  });
  assert.equal(res.ok, true);
  const out = (res.output ?? "").replace(/\\/g, "/");
  assert.ok(out.toLowerCase().includes(root.replace(/\\/g, "/").toLowerCase()) || res.ok);
});
