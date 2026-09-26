import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolRegistry } from "../ai/ToolTypes";
import { makeEditFileTool, makeReadFileTool, makeWriteFileTool } from "../ai/tools/fileTools";
import { makeTerminalTool } from "../ai/tools/terminalTool";
import { PermissionEngine } from "./PermissionEngine";
import { ToolGateway } from "./ToolGateway";
import { buildToolResultEnvelope, displayPath } from "./toolResultEnvelope";

function gatewayFor(root: string): ToolGateway {
  const registry = new ToolRegistry();
  for (const t of [makeReadFileTool(root), makeWriteFileTool(root), makeEditFileTool(root), makeTerminalTool(root)]) {
    registry.register(t);
    registry.setPermission(t.name, "allowed");
  }
  return new ToolGateway(registry, new PermissionEngine());
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const KEYS = ["toolName", "status", "modelPayload", "userSummary", "structuredData", "evidence", "retryable"];

test("write_file then read_file: evidence names the operation and hello.txt", async () => {
  const root = mkdtempSync(join(tmpdir(), "orvyn-env-"));
  const gw = gatewayFor(root);
  const content = "Hello from ORION\n";

  const write = await gw.execute("write_file", { path: "hello.txt", content }, "coder", { workspaceRoot: root, toolUseId: "call_1" });
  const w = write.envelope!;
  for (const k of KEYS) assert.ok(k in w, `write envelope has ${k}`);
  assert.equal(w.toolName, "write_file");
  assert.equal(w.toolUseId, "call_1");
  assert.equal(w.status, "success");
  assert.equal(w.modelPayload, write.output);
  assert.equal(w.retryable, false);
  assert.deepEqual(w.evidence.map((e) => ({ type: e.type, operation: e.operation, file: e.file })), [{ type: "file", operation: "write", file: "hello.txt" }]);
  assert.equal(w.structuredData.sha256, sha(content));
  assert.equal(w.structuredData.bytes, Buffer.byteLength(content));
  assert.equal(w.structuredData.kind, "create");
  assert.match(w.userSummary, /^Wrote hello\.txt · 17 bytes$/);

  // An absolute path inside the workspace is still shown as hello.txt.
  const read = await gw.execute("read_file", { path: join(root, "hello.txt") }, "coder", { workspaceRoot: root });
  const r = read.envelope!;
  assert.equal(r.status, "success");
  assert.deepEqual(r.evidence.map((e) => ({ type: e.type, operation: e.operation, file: e.file })), [{ type: "file", operation: "read", file: "hello.txt" }]);
  assert.equal(r.structuredData.sha256, w.structuredData.sha256, "read back exactly what was written");
  assert.equal(r.structuredData.lines, 1);
  assert.equal(r.modelPayload, content);

  const edit = await gw.execute("edit_file", { path: "hello.txt", old_string: "ORION", new_string: "ORVYN" }, "coder", { workspaceRoot: root });
  assert.equal(edit.envelope!.evidence[0]?.operation, "edit");
  assert.equal(edit.envelope!.evidence[0]?.file, "hello.txt");
});

test("terminal: command evidence with exit code; failures are not dressed up", async () => {
  const root = mkdtempSync(join(tmpdir(), "orvyn-env-"));
  const gw = gatewayFor(root);
  const ok = (await gw.execute("terminal", { command: "echo hi" }, "coder", { workspaceRoot: root })).envelope!;
  assert.equal(ok.status, "success");
  assert.deepEqual(ok.evidence[0], { type: "command", label: "Shell command", value: "echo hi", command: "echo hi", operation: "run", extra: { exitCode: 0, ok: true, timedOut: undefined } });
  assert.equal(ok.userSummary, "Ran echo hi · exit 0");
  assert.match(String(ok.structuredData.outputTail), /hi/);

  const bad = (await gw.execute("terminal", { command: "exit 3" }, "coder", { workspaceRoot: root })).envelope!;
  assert.equal(bad.status, "error");
  assert.equal(bad.structuredData.exitCode, 3);
  assert.equal(bad.evidence[0]?.extra?.exitCode, 3);
  assert.equal(bad.evidence.some((e) => e.type === "runtime_log"), true);
  assert.match(bad.userSummary, /exit 3/);
  assert.equal(bad.retryable, false);
});

test("a failed read has no file evidence and is not retryable; a timeout is", async () => {
  const root = mkdtempSync(join(tmpdir(), "orvyn-env-"));
  const gw = gatewayFor(root);
  const missing = (await gw.execute("read_file", { path: "nope.txt" }, "coder", { workspaceRoot: root })).envelope!;
  assert.equal(missing.status, "error");
  assert.equal(missing.evidence.some((e) => e.type === "file"), false);
  assert.equal(missing.retryable, false);
  assert.match(missing.userSummary, /^Could not read nope\.txt: /);

  const timeout = buildToolResultEnvelope({ toolName: "terminal", args: { command: "npm install" }, result: { ok: false, error: "Remote tool \"terminal\" timed out after 330000ms" } });
  assert.equal(timeout.retryable, true);
});

test("the gateway wraps denials as blocked and turns a throwing tool into an error result", async () => {
  const registry = new ToolRegistry();
  registry.register({ name: "boom", description: "", parameters: {}, defaultPermission: "allowed", execute: async () => { throw new Error("kaboom"); } });
  registry.register({ name: "nope", description: "", parameters: {}, defaultPermission: "denied", execute: async () => ({ ok: true }) });
  const gw = new ToolGateway(registry, new PermissionEngine());
  const thrown = await gw.execute("boom", {});
  assert.equal(thrown.ok, false);
  assert.equal(thrown.envelope?.status, "error");
  assert.equal(thrown.envelope?.modelPayload, "kaboom");
  const denied = await gw.execute("nope", {});
  assert.equal(denied.envelope?.status, "blocked");
  assert.equal(denied.envelope?.retryable, false);
});

test("paths are shown relative to the workspace, Windows or POSIX", () => {
  assert.equal(displayPath("C:\\Users\\me\\proj\\src\\a.ts", "C:\\Users\\me\\proj"), "src/a.ts");
  assert.equal(displayPath("/srv/ws/t1/hello.txt", "/srv/ws/t1"), "hello.txt");
  assert.equal(displayPath("./hello.txt", "/srv/ws/t1"), "hello.txt");
  assert.equal(displayPath("/etc/passwd", "/srv/ws/t1"), "/etc/passwd");
});

test("web_search and fetch_url name the sites ORION used (url evidence)", () => {
  const search = buildToolResultEnvelope({
    toolName: "web_search",
    args: { query: "KXM model training" },
    result: { ok: true, output: "1. Scaling laws\n   https://arxiv.org/abs/2001.08361\n   Compute-optimal training…\n2. Hugging Face docs\n   https://huggingface.co/docs\n   Transformers" },
  });
  assert.equal(search.userSummary, 'Searched the web for "KXM model training" · 2 results');
  assert.deepEqual(search.evidence.map((e) => [e.type, e.value, e.label, (e.extra as any).kind]), [
    ["url", "https://arxiv.org/abs/2001.08361", "Scaling laws", "search"],
    ["url", "https://huggingface.co/docs", "Hugging Face docs", "search"],
  ]);
  const read = buildToolResultEnvelope({ toolName: "fetch_url", args: { url: "https://nvidia.com/blog" }, result: { ok: true, output: "HTTP 200 text/html\n\n<title>NVIDIA Blog</title>…" } });
  assert.deepEqual(read.evidence.map((e) => [e.type, e.value, e.label, (e.extra as any).kind]), [["url", "https://nvidia.com/blog", "NVIDIA Blog", "read"]]);
  const failed = buildToolResultEnvelope({ toolName: "fetch_url", args: { url: "https://x.test" }, result: { ok: false, error: "Fetch failed: timeout" } });
  assert.equal(failed.evidence.filter((e) => e.type === "url").length, 0);
});
