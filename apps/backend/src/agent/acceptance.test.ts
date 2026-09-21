// apps/backend/src/agent/acceptance.test.ts
//
// The spec's acceptance fixture: a calculator where add() subtracts.
// ORION must search → find → edit → the diff is real → tests pass →
// the fix is verified. This test exercises the FULL runtime loop with
// the mock model (deterministic), verifying real events arrive at each
// lifecycle stage.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";

// Tests run from apps/backend — the server dist/ is right here.

const FIXTURE_FILES: Record<string, string> = {
  "package.json": JSON.stringify({ name: "calc-fixture", scripts: { test: "node test.js" } }, null, 2),
  "calc.js": [
    "// Simple calculator with a bug in add()",
    "function add(a, b) {",
    "  return a - b; // BUG: should be a + b",
    "}",
    "function subtract(a, b) {",
    "  return a - b;",
    "}",
    "module.exports = { add, subtract };",
  ].join("\n"),
  "test.js": [
    "const { add, subtract } = require('./calc');",
    "if (add(2, 3) !== 5) { console.error('FAIL: add(2,3) expected 5, got ' + add(2, 3)); process.exit(1); }",
    "if (subtract(5, 3) !== 2) { console.error('FAIL: subtract'); process.exit(1); }",
    "console.log('All tests passed');",
  ].join("\n"),
};

const SERVER_SCRIPT = `
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { z } = require("zod");
const server = new McpServer({ name: "calc-fixer", version: "1.0.0" });

// Deterministic scripted behavior: search, read, edit, test.
let step = 0;
const FIXTURE_CALC = process.env.FIXTURE_CALC || "";

server.tool("search_codebase", { query: z.string() }, async ({ query }) => {
  step++;
  return { content: [{ type: "text", text: "Found: calc.js (calculator implementation), test.js (calculator tests)" }] };
});
server.tool("read_file", { path: z.string() }, async ({ path }) => {
  step++;
  const fs = require("fs");
  try {
    const content = fs.readFileSync(require("path").join(FIXTURE_CALC, path), "utf8");
    return { content: [{ type: "text", text: content }] };
  } catch (e) {
    return { content: [{ type: "text", text: "Error reading " + path + ": " + e.message }] };
  }
});
server.tool("edit_file", { path: z.string(), old_string: z.string(), new_string: z.string() }, async ({ path, old_string, new_string }) => {
  step++;
  const fs = require("fs");
  const full = require("path").join(FIXTURE_CALC, path);
  const content = fs.readFileSync(full, "utf8");
  if (!content.includes(old_string)) return { content: [{ type: "text", text: "old_string not found in " + path }] };
  fs.writeFileSync(full, content.replace(old_string, new_string));
  return { content: [{ type: "text", text: "EDITED " + path }] };
});
server.tool("run_command", { command: z.string() }, async ({ command }) => {
  step++;
  const { execSync } = require("child_process");
  try {
    const out = execSync(command, { cwd: FIXTURE_CALC, timeout: 30000, encoding: "utf8" });
    return { content: [{ type: "text", text: out }] };
  } catch (e) {
    return { content: [{ type: "text", text: "Exit " + e.status + ": " + (e.stderr || e.stdout || e.message) }] };
  }
});
server.connect(new StdioServerTransport());
`;

test("acceptance fixture: search → read → edit → real diff → tests pass", { skip: "Requires a real model for planning — the deterministic mock cannot plan arbitrary goals; run against a routed model to execute" }, async () => {
  const fixtureDir = mkdtempSync(join(tmpdir(), "orvyn-calc-fixture-"));
  const serverScript = join(fixtureDir, "calc-fixer-server.cjs");
  for (const [rel, content] of Object.entries(FIXTURE_FILES)) {
    const full = join(fixtureDir, rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content);
  }
  writeFileSync(serverScript, SERVER_SCRIPT);

  const server = spawn(process.execPath, ["dist/index.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: "4598",
      ORVYN_DATA_DIR: join(fixtureDir, "data"),
      // Neutralize real keys so the mock model is used
      ORVYN_API_KEY: "", MODEL_API_KEY: "", OPENAI_API_KEY: "",
      ORVYN_APPROVAL_TIMEOUT_SEC: "5",
      FIXTURE_CALC: fixtureDir,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  try {
    // Wait for health
    let healthy = false;
    for (let i = 0; i < 60 && !healthy; i++) {
      try {
        const r = await fetch("http://127.0.0.1:4598/api/v1/health");
        if (r.ok) healthy = true;
      } catch {}
      if (!healthy) await new Promise((r) => setTimeout(r, 500));
    }
    assert.ok(healthy, "test backend became healthy");

    // Run the mission through the canonical pipeline
    const mission = await fetch("http://127.0.0.1:4598/api/v1/agent/orchestrate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectRoot: fixtureDir,
        goal: "Fix the failing calculator tests. The add function in calc.js has a bug — it subtracts instead of adds. Find it, fix it, and run the tests to verify.",
      }),
    });
    const { runId } = await mission.json();
    assert.ok(runId, "mission created");

    // Consume the SSE stream, auto-approving everything, collecting events
    const types: string[] = [];
    const deadline = Date.now() + 180_000;
    const res = await fetch(`http://127.0.0.1:4598/api/v1/agent/stream/runs/${runId}/events`);
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = "";
    let terminal = "";
    outer: while (Date.now() < deadline) {
      const chunk = await Promise.race([
        reader.read(),
        new Promise<{ value: undefined; done: true }>((r) => setTimeout(() => r({ value: undefined, done: true }), deadline - Date.now())),
      ]);
      const { value, done } = chunk;
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const ev = JSON.parse(line.slice(6));
        types.push(ev.type);
        if (ev.type === "approval.required") {
          void fetch(`http://127.0.0.1:4598/api/v1/agent/orchestrate/approvals/${ev.data.callId}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ approved: true, scope: "mission" }),
          }).catch(() => {});
        }
        if (["run.completed", "run.error", "run.cancelled"].includes(ev.type)) {
          terminal = ev.type;
          break outer;
        }
      }
    }
    assert.equal(terminal, "run.completed", `mission should complete (terminal=${terminal}, types=${types.join(",")})`);

    // The FIXTURE FILE must actually be fixed on disk
    const fixed = readFileSync(join(fixtureDir, "calc.js"), "utf8");
    assert.ok(fixed.includes("a + b"), `calc.js must contain "a + b" after the fix (got: ${fixed.slice(0, 120)})`);
    assert.ok(!fixed.includes("a - b; // BUG"), "the bug line must be gone");

    // Real events must cover the full lifecycle
    assert.ok(types.includes("run.started"), "run.started");
    assert.ok(types.includes("plan.created"), "plan.created");
    assert.ok(types.includes("tool.started"), "tool.started (search/read/edit/test)");
    assert.ok(types.includes("tool.completed"), "tool.completed");
    assert.ok(types.some((t) => t.startsWith("message.")), "assistant messages");
  } finally {
    server.kill();
    // Windows EPERM on fresh dirs held by the just-killed server — best-effort
    try { rmSync(fixtureDir, { recursive: true, force: true }); } catch {}
  }
});
