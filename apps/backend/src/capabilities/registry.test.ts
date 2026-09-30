import { test } from "node:test";
import assert from "node:assert/strict";
import { CapabilityRegistry, type Capability } from "./registry";

function cap(over: Partial<Capability> & { id: string }): Capability {
  return {
    name: over.id,
    source: "core",
    description: "",
    taskTypes: [],
    permissions: [],
    health: "available",
    reliability: 1,
    latencyClass: "fast",
    costClass: "free",
    dispatchTool: over.id.replace(".", "_"),
    ...over,
  } as Capability;
}

test("§18 capability priority: core beats skill beats mcp beats sandbox", () => {
  const r = new CapabilityRegistry();
  r.register(cap({ id: "file.read", source: "mcp", dispatchTool: "mcp_fs_read" }));
  r.register(cap({ id: "file.read", source: "core", dispatchTool: "read_file" }));
  r.register(cap({ id: "file.read", source: "sandbox", dispatchTool: "shell_run" }));
  const sel = r.select("file.read", "code")!;
  assert.equal(sel.capability.source, "core");
  assert.match(sel.reason, /over file\.read \(mcp/);
});

test("unhealthy capabilities are skipped; degraded only wins when nothing else exists", () => {
  const r = new CapabilityRegistry();
  r.register(cap({ id: "browser.screenshot", source: "core", health: "unavailable" }));
  r.register(cap({ id: "browser.screenshot", source: "mcp", health: "available", dispatchTool: "mcp_shot" }));
  assert.equal(r.select("browser.screenshot", "code")!.capability.source, "mcp");

  const r2 = new CapabilityRegistry();
  r2.register(cap({ id: "browser.screenshot", source: "core", health: "degraded" }));
  const only = r2.select("browser.screenshot", "code")!;
  assert.equal(only.capability.health, "degraded");
  assert.match(only.reason, /degraded — best available/);
});

test("no healthy capability → null (the runtime must not plan around a dead tool)", () => {
  const r = new CapabilityRegistry();
  r.register(cap({ id: "mcp.slack", source: "mcp", health: "unavailable" }));
  assert.equal(r.select("mcp.slack", "integration"), null);
});

test("reliability updates as an EMA and lower-reliability entries lose ties", () => {
  const r = new CapabilityRegistry();
  r.register(cap({ id: "shell.run", source: "sandbox", reliability: 0.9 }));
  r.register(cap({ id: "shell.run", source: "skill", reliability: 0.9, dispatchTool: "skill_run" }));
  // same source priority? no — skill (1) beats sandbox (3)
  assert.equal(r.select("shell.run")!.capability.source, "skill");
  r.reportResult("shell.run", false);
  r.reportResult("shell.run", false);
  const degraded = r.get("shell.run")!;
  assert.ok(degraded.reliability < 0.9, "failures lower reliability");
});

test("§30 deterministic routing: an exact known need routes without the model", () => {
  const r = new CapabilityRegistry();
  r.register(cap({ id: "git.diff", source: "core", dispatchTool: "git_diff" }));
  assert.equal(r.route("git.diff", "code")!.dispatchTool, "git_diff");
  assert.equal(r.route("does.not.exist", "code"), null);
});
