import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { routeExecutionTarget } from "./ExecutionTarget";
import { DockerSandbox } from "../sandbox/DockerSandbox";
import { LocalSandboxExecutor } from "../localWorker/LocalSandboxExecutor";
import { ToolGateway } from "../gateway/ToolGateway";
import { PermissionEngine } from "../gateway/PermissionEngine";
import { ToolRegistry } from "../ai/ToolTypes";

test("Desktop/Cloud target matrix preserves explicit Host and requires the server worker", () => {
  assert.equal(routeExecutionTarget({ hasLocalProject: true, isLocalCoding: true, desktopProject: true, cloudControlPlane: true }).actual, "local_sandbox");
  assert.equal(routeExecutionTarget({ hasLocalProject: true, isLocalCoding: true, cloudControlPlane: true }).actual, "ovh_worker");
  assert.equal(routeExecutionTarget({ isRisky: true, cloudControlPlane: true }).actual, "ovh_worker");
  assert.equal(routeExecutionTarget({ mode: "server", desktopProject: true }).actual, "ovh_worker");
  assert.equal(routeExecutionTarget({ requested: "local_host", hasLocalProject: true }).actual, "local_host");
});

test("same gateway reports denied and missing tools as failures for both products", async () => {
  for (const executionTarget of ["local_sandbox", "cloud_worker"] as const) {
    let ran = false;
    const gateway = new ToolGateway(new ToolRegistry(), new PermissionEngine());
    gateway.register({ name: "read_file", description: "Fixture", parameters: { type: "object" }, defaultPermission: "denied", execute: async () => { ran = true; return { ok: true, output: "unreachable" }; } });
    const denied = await gateway.execute("read_file", { path: "fixture.txt" }, "coder", { workspaceRoot: tmpdir(), executionTarget });
    assert.equal(denied.ok, false); assert.equal(ran, false); assert.ok(denied.envelope);
    const missing = await gateway.execute("missing_mcp", {}, "coder", { workspaceRoot: tmpdir(), executionTarget });
    assert.equal(missing.ok, false); assert.ok(missing.error);
  }
});

test("real Desktop sandbox edits, tests, excludes credentials, merges results and cancels without host execution", async (t) => {
  if (process.env.ORVYN_REQUIRE_SANDBOX_TEST !== "1") { t.skip("Runs in the explicit Docker release gate"); return; }
  if (!await DockerSandbox.available()) {
    assert.notEqual(process.env.ORVYN_REQUIRE_SANDBOX_TEST, "1", "Docker is required for the release acceptance gate");
    t.skip("No Docker daemon on this machine; release CI requires this test"); return;
  }
  const root = mkdtempSync(join(tmpdir(), "orvyn-sandbox-matrix-"));
  const executor = new LocalSandboxExecutor();
  writeFileSync(join(root, "math.js"), "module.exports.add=(a,b)=>a-b;\n");
  writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { test: "node -e \"if(require('./math').add(2,3)!==5)process.exit(1)\"" } }));
  writeFileSync(join(root, ".env"), "SECRET=fixture-must-stay-out\n");
  const req = (tool: string, args: Record<string, unknown>) => executor.execute({ tool, arguments: args, projectRoot: root });
  try {
    await executor.start(`matrix${Date.now()}`, root);
    assert.equal((await req("run_tests", {})).ok, false);
    assert.equal((await req("edit_file", { path: "math.js", old_string: "a-b", new_string: "a+b" })).ok, true);
    assert.match(readFileSync(join(root, "math.js"), "utf8"), /a-b/, "host file remains unchanged while the sandbox runs");
    assert.equal((await req("run_tests", {})).ok, true);
    assert.equal((await req("read_file", { path: ".env" })).ok, false);
    assert.equal((await req("missing_mcp", {})).ok, false);
    await executor.finish(root, true);
    assert.match(readFileSync(join(root, "math.js"), "utf8"), /a\+b/);
    assert.match(readFileSync(join(root, ".env"), "utf8"), /fixture-must-stay-out/);
    await executor.start(`cancel${Date.now()}`, root);
    const pending = req("terminal", { command: "sleep 30" });
    await new Promise((r) => setTimeout(r, 300));
    await executor.finish(root, false);
    assert.equal((await pending).ok, false);
  } finally { await executor.finish(root, false); rmSync(root, { recursive: true, force: true }); }
});
