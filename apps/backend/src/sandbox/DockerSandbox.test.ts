// apps/backend/src/sandbox/DockerSandbox.test.ts
//
// Unit tests run everywhere; the container round-trip only runs where a
// Docker daemon answers (OVH/CI). The round-trip is the one that matters —
// it proves commands execute inside the container and files flow back out.

import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "fs";
import * as path from "path";
import * as os from "os";
import { DockerSandbox } from "./DockerSandbox";
import { makeSandboxTerminalTool, SANDBOX_DENIED_TOOLS, sandboxDenialMessage } from "../ai/tools/sandboxTools";

test("denial messages tell the agent the sandbox path, not just 'no'", () => {
  for (const tool of SANDBOX_DENIED_TOOLS) {
    const msg = sandboxDenialMessage(tool);
    assert.match(msg, new RegExp(`"${tool}"`));
    assert.match(msg, /sandbox/);
  }
});

test("sandbox terminal tool runs commands from /workspace and honours cwd", async () => {
  const calls: string[] = [];
  const stub = {
    exec: async (command: string) => {
      calls.push(command);
      return { ok: true, output: "stubbed", exitCode: 0, timedOut: false };
    },
  } as unknown as DockerSandbox;

  const tool = makeSandboxTerminalTool(stub);
  assert.equal(tool.name, "terminal");
  assert.equal(tool.defaultPermission, "ask", "sandbox terminal must keep per-call approval");

  await tool.execute({ command: "npm test" });
  assert.equal(calls[0], "cd /workspace && (npm test)");

  await tool.execute({ command: "npm test", cwd: "packages/app" });
  assert.equal(calls[1], "cd /workspace/packages/app && (npm test)");

  const empty = await tool.execute({ command: "" });
  assert.equal(empty.ok, false);
});

test("sandbox terminal reports timeouts as errors with partial output", async () => {
  const stub = {
    exec: async () => ({ ok: false, output: "partial build log", exitCode: 137, timedOut: true }),
  } as unknown as DockerSandbox;
  const tool = makeSandboxTerminalTool(stub);
  const result = await tool.execute({ command: "npm run build" });
  assert.equal(result.ok, false);
  assert.match(String(result.error), /timed out/);
  assert.match(String(result.error), /partial build log/);
});

test("container round-trip: exec inside, file out, container removed", async (t) => {
  const available = await DockerSandbox.available();
  if (!available) {
    t.skip("Docker daemon not reachable here — run this suite on a Docker host (e.g. the OVH server)");
    return;
  }

  const project = await fs.mkdtemp(path.join(os.tmpdir(), "orvyn-sbx-test-"));
  await fs.writeFile(path.join(project, "app.js"), "console.log('from sandbox');\n", "utf-8");

  const sandbox = await DockerSandbox.start("test-mission", project);
  t.after(() => sandbox.stop());

  try {
    // Command executes INSIDE the container, against the copied-in project.
    const ran = await sandbox.exec("node /workspace/app.js");
    assert.equal(ran.ok, true, `node should run the copied project: ${ran.output}`);
    assert.match(ran.output, /from sandbox/);

    // Network isolation: no route out even if code tries.
    const net = await sandbox.exec("node -e \"fetch('http://example.com').then(()=>console.log('leak')).catch(e=>console.log('blocked:', e.message))\"");
    assert.match(net.output, /blocked/i);

    // A file created by the command flows back to the host on mergeBack.
    await sandbox.exec("echo generated > /workspace/GENERATED_BY_SANDBOX.txt");
    const { mergedFiles } = await sandbox.mergeBack(project);
    assert.ok(mergedFiles > 0, "at least the project file should merge back");
    assert.ok(
      await fs.readFile(path.join(project, "GENERATED_BY_SANDBOX.txt"), "utf-8").then((s) => s.includes("generated")).catch(() => false),
      "the file created inside the container must land on the host"
    );
  } finally {
    await sandbox.stop();
    await fs.rm(project, { recursive: true, force: true }).catch(() => {});
  }
});
