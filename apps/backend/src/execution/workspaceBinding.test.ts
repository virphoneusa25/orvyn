import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ToolRegistry } from "../ai/ToolTypes";
import { makeReadFileTool, makeWriteFileTool } from "../ai/tools/fileTools";
import { makeListDirectoryTool } from "../ai/tools/fileTools";
import { makeTerminalTool } from "../ai/tools/terminalTool";
import { makeSshExecTool } from "../ai/tools/sshTools";
import { PermissionEngine } from "../gateway/PermissionEngine";
import { ToolGateway } from "../gateway/ToolGateway";
import { RunStore } from "../agent/events";
import { projectToolContext } from "./workspaceBinding";

test("read and create stay inside the run workspace, and escapes are refused", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "orvyn-bind-ws-"));
  const decoy = mkdtempSync(join(tmpdir(), "orvyn-bind-decoy-"));
  writeFileSync(join(workspace, "existing.txt"), "already here\n");
  mkdirSync(join(workspace, ".orvyn"), { recursive: true });
  writeFileSync(join(workspace, ".orvyn", "ssh.json"), JSON.stringify({
    hosts: [{ alias: "ovh", host: "10.0.0.9", user: "ubuntu" }],
  }));

  const registry = new ToolRegistry();
  for (const tool of [makeReadFileTool(decoy), makeWriteFileTool(decoy), makeListDirectoryTool(decoy), makeTerminalTool(decoy), makeSshExecTool(decoy)]) {
    registry.register(tool);
    registry.setPermission(tool.name, "allowed");
  }
  registry.register({ ...registry.list().find((tool) => tool.name === "write_file")!, name: "create_file", description: "alias" });
  registry.setPermission("create_file", "allowed");
  const gateway = new ToolGateway(registry, new PermissionEngine());

  const store = new RunStore();
  const run = store.create("run_bind", workspace);
  store.bindWorkspace(run.id, "ws_bind");
  assert.equal(store.get(run.id)?.projectRoot, workspace);
  assert.equal(store.get(run.id)?.workspaceId, "ws_bind");

  const ctx = projectToolContext({ projectRoot: workspace, workspaceId: "ws_bind", runId: run.id });
  assert.equal(ctx.workspaceRoot, workspace);
  assert.equal(ctx.workspaceId, "ws_bind");

  const read = await gateway.execute("read_file", { path: "existing.txt" }, "coder", ctx);
  assert.equal(read.ok, true, read.error);
  assert.match(String(read.output), /already here/);

  const created = await gateway.execute("write_file", { path: "new.txt", content: "created\n" }, "coder", ctx);
  assert.equal(created.ok, true, created.error);
  assert.equal(readFileSync(join(workspace, "new.txt"), "utf8"), "created\n");
  assert.equal(existsSync(join(decoy, "new.txt")), false);
  assert.equal(existsSync(join(decoy, "existing.txt")), false);

  const listed = await gateway.execute("list_directory", { path: "." }, "coder", ctx);
  assert.match(String(listed.output), /existing\.txt/);
  assert.match(String(listed.output), /new\.txt/);

  const viaAlias = await gateway.execute("create_file", { path: "also.txt", content: "alias\n" }, "coder", ctx);
  assert.equal(viaAlias.ok, true, viaAlias.error);
  assert.equal(readFileSync(join(workspace, "also.txt"), "utf8"), "alias\n");

  const pwd = await gateway.execute("terminal", { command: "pwd" }, "coder", ctx);
  assert.equal(pwd.ok, true, pwd.error);
  assert.equal(resolve(String(pwd.output).trim()), realpathSync(workspace));

  const outside = resolve(workspace, "../../outside.txt");
  const escaped = await gateway.execute("write_file", { path: "../../outside.txt", content: "nope\n" }, "coder", ctx);
  assert.equal(escaped.ok, false);
  assert.match(String(escaped.error), /escapes|outside|refused/i);
  assert.equal(existsSync(outside), false);
  assert.equal(existsSync(join(workspace, "outside.txt")), false);

  const remote = await gateway.execute("ssh_exec", { host: "not-configured", command: "cat ../../outside.txt" }, "coder", ctx);
  assert.equal(remote.ok, false);
  assert.match(String(remote.error), /Unknown host alias/);
  assert.match(String(remote.error), /ovh/);
  assert.doesNotMatch(String(remote.error), /escapes the project root/);
  assert.equal(existsSync(outside), false);
});
