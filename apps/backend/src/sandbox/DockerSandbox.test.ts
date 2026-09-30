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
import {
  makeSandboxTerminalTool,
  makeSandboxVerificationTools,
  makeSandboxProcessTools,
  sandboxCwd,
  sandboxDenialMessage,
  type SandboxExec,
  type SandboxExecRequest,
} from "../ai/tools/sandboxTools";

test("denial messages tell the agent the sandbox path, not just 'no'", () => {
  for (const tool of ["run_tests", "some_future_host_tool"]) {
    const msg = sandboxDenialMessage(tool);
    assert.match(msg, new RegExp(`"${tool}"`));
    assert.match(msg, /sandbox/);
  }
});

test("sandboxCwd normalizes safe paths and refuses every escape flavour", () => {
  assert.equal(sandboxCwd(""), "");
  assert.equal(sandboxCwd(undefined), "");
  assert.equal(sandboxCwd("packages/app"), "packages/app");
  assert.equal(sandboxCwd("packages//app/"), "packages/app");
  assert.equal(sandboxCwd("./a/./b"), "a/b");
  // Escapes: parent segments, absolute roots, windows separators, ~,
  // percent-encoded traversal and NUL bytes all refuse — nothing is executed.
  assert.equal(sandboxCwd(".."), null);
  assert.equal(sandboxCwd("../secret"), null);
  assert.equal(sandboxCwd("a/../../b"), null);
  assert.equal(sandboxCwd("/etc/passwd"), null, "absolute paths are not workspace-relative");
  assert.equal(sandboxCwd("..\\..\\win"), null);
  assert.equal(sandboxCwd("~/.ssh"), null);
  assert.equal(sandboxCwd("%2e%2e/secrets"), null);
  assert.equal(sandboxCwd("%2e%2e%2fsecrets"), null);
});

test("sandbox terminal prefers structured provider execution with native cwd", async () => {
  const calls: SandboxExecRequest[] = [];
  const stub: SandboxExec = {
    exec: async () => ({ ok: false, output: "legacy path should not run", exitCode: 1, timedOut: false }),
    execStructured: async (req) => {
      calls.push(req);
      return { ok: true, stdout: "out-text", stderr: "err-text", output: "out-text\nerr-text", exitCode: 0, timedOut: false };
    },
  };
  const tool = makeSandboxTerminalTool(stub);
  const r = await tool.execute({ command: "npm test", cwd: "packages/app" });
  assert.equal(r.ok, true);
  assert.deepEqual(calls.map((c) => ({ command: c.command, cwd: c.cwd })), [{ command: "npm test", cwd: "packages/app" }]);
});

test("sandbox terminal falls back to exec() shell-composed cwd for legacy providers", async () => {
  const calls: string[] = [];
  const stub = {
    exec: async (command: string) => {
      calls.push(command);
      return { ok: true, output: "stubbed", exitCode: 0, timedOut: false };
    },
  } as unknown as SandboxExec;
  const tool = makeSandboxTerminalTool(stub);
  await tool.execute({ command: "npm test" });
  assert.equal(calls[0], "cd /workspace && (npm test)");
  await tool.execute({ command: "npm test", cwd: "packages/app" });
  assert.equal(calls[1], "cd /workspace/packages/app && (npm test)");
});

test("sandbox terminal refuses a cwd escape before anything executes", async () => {
  const calls: unknown[] = [];
  const stub = {
    exec: async (c: string) => { calls.push(c); return { ok: true, output: "", exitCode: 0, timedOut: false }; },
    execStructured: async (r: SandboxExecRequest) => { calls.push(r); return { ok: true, stdout: "", stderr: "", output: "", exitCode: 0, timedOut: false }; },
  } satisfies SandboxExec;
  const tool = makeSandboxTerminalTool(stub);
  for (const bad of ["../escape", "/etc", "..\\win", "%2e%2e/secrets", "~/.aws"]) {
    const r = await tool.execute({ command: "ls", cwd: bad });
    assert.equal(r.ok, false, bad);
    assert.equal(r.errorType, "INVALID_ARGUMENTS", bad);
  }
  assert.equal(calls.length, 0, "no call reaches the provider");
});

test("sandbox run_tests detects the runner on the host tree and executes inside the sandbox", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "orvyn-sbx-tools-"));
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "vitest run" } }), "utf-8");
  const calls: SandboxExecRequest[] = [];
  const stub: SandboxExec = {
    exec: async () => ({ ok: false, output: "legacy", exitCode: 1, timedOut: false }),
    execStructured: async (req) => {
      calls.push(req);
      return { ok: true, stdout: "5 passed", stderr: "", output: "5 passed", exitCode: 0, timedOut: false };
    },
  };
  const tools = makeSandboxVerificationTools(stub, root);
  const runTests = tools.find((t) => t.name === "run_tests")!;
  assert.equal(runTests.defaultPermission, "ask");
  const r = await runTests.execute({ filter: "login" });
  assert.equal(r.ok, true, String(r.error));
  assert.match(String(r.output), /npm test -- "login"/);
  assert.equal(calls[0]!.cwd, "");
  await fs.rm(root, { recursive: true, force: true });
});

test("sandbox run_tests reports a missing runner as RESOURCE_MISSING, not a fake pass", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "orvyn-sbx-tools-"));
  const stub: SandboxExec = { exec: async () => ({ ok: true, output: "", exitCode: 0, timedOut: false }) };
  const runTests = makeSandboxVerificationTools(stub, root).find((t) => t.name === "run_tests")!;
  const r = await runTests.execute({});
  assert.equal(r.ok, false);
  assert.equal(r.errorType, "RESOURCE_MISSING");
  await fs.rm(root, { recursive: true, force: true });
});

test("a failing sandbox test suite is a failed tool call, not a pass", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "orvyn-sbx-tools-"));
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "vitest run" } }), "utf-8");
  const stub: SandboxExec = {
    exec: async () => ({ ok: false, output: "", exitCode: 1, timedOut: false }),
    execStructured: async () => ({ ok: false, stdout: "1 failed", stderr: "", output: "1 failed", exitCode: 1, timedOut: false }),
  };
  const runTests = makeSandboxVerificationTools(stub, root).find((t) => t.name === "run_tests")!;
  const r = await runTests.execute({});
  assert.equal(r.ok, false);
  assert.equal(r.errorType, "EXECUTION_FAILED");
  await fs.rm(root, { recursive: true, force: true });
});

test("sandbox process tools use the provider lifecycle and fail closed without it", async () => {
  const started: { command: string; cwd?: string }[] = [];
  const stub: SandboxExec = {
    exec: async () => ({ ok: true, output: "", exitCode: 0, timedOut: false }),
    startProcess: async (req) => {
      started.push(req);
      return { id: "proc_1", command: req.command, cwd: req.cwd ?? "", pid: 4242, startedAt: Date.now(), status: "running" };
    },
    stopProcess: async () => ({ ok: true }),
    processLogs: async () => ({ stdout: "vite listening", stderr: "" }),
    listProcesses: async () => [{ id: "proc_1", command: "npm run dev", cwd: "", startedAt: Date.now(), status: "running" }],
  };
  const tools = makeSandboxProcessTools(stub);
  const start = tools.find((t) => t.name === "start_process")!;
  const r = await start.execute({ command: "npm run dev", cwd: "app" });
  assert.equal(r.ok, true, String(r.error));
  assert.deepEqual(started, [{ command: "npm run dev", cwd: "app" }]);
  const list = tools.find((t) => t.name === "list_processes")!;
  assert.match(String((await list.execute({})).output), /proc_1.*npm run dev/);
  const logs = tools.find((t) => t.name === "read_process_logs")!;
  assert.match(String((await logs.execute({ id: "proc_1" })).output), /vite listening/);
  const stop = tools.find((t) => t.name === "stop_process")!;
  assert.equal((await stop.execute({ id: "proc_1" })).ok, true);

  // A provider without the surface reports CAPABILITY_UNAVAILABLE — not a
  // silent host fallback.
  const bare: SandboxExec = { exec: async () => ({ ok: true, output: "", exitCode: 0, timedOut: false }) };
  const noSurface = makeSandboxProcessTools(bare).find((t) => t.name === "start_process")!;
  const refused = await noSurface.execute({ command: "npm run dev" });
  assert.equal(refused.ok, false);
  assert.equal(refused.errorType, "CAPABILITY_UNAVAILABLE");
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
