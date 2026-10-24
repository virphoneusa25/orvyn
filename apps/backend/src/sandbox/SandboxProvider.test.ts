// apps/backend/src/sandbox/SandboxProvider.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import {
  configuredSandboxProvider,
  type SandboxSession,
} from "./SandboxProvider";
import { VercelSandboxProvider } from "./VercelSandboxProvider";
import { makeSandboxTerminalTool } from "../ai/tools/sandboxTools";

const ENV_KEYS = [
  "ORVYN_SANDBOX_PROVIDER",
  "SANDBOX_VERCEL_TOKEN",
  "SANDBOX_VERCEL_TEAM_ID",
  "SANDBOX_VERCEL_PROJECT_ID",
  "VERCEL_TOKEN",
  "VERCEL_TEAM_ID",
  "VERCEL_PROJECT_ID",
] as const;

function withCleanEnv(fn: () => Promise<void> | void): Promise<void> | void {
  const saved = new Map<string, string | undefined>();
  for (const key of ENV_KEYS) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }

  const restore = () => {
    for (const key of ENV_KEYS) {
      const value = saved.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };

  try {
    const result = fn();
    if (result && typeof (result as Promise<void>).then === "function") {
      return (result as Promise<void>).finally(restore);
    }
    restore();
  } catch (err) {
    restore();
    throw err;
  }
}

test("Docker remains the default sandbox provider", () => {
  withCleanEnv(() => {
    assert.equal(configuredSandboxProvider(), "docker");
  });
});

test("Vercel provider is explicitly selectable", () => {
  withCleanEnv(() => {
    process.env.ORVYN_SANDBOX_PROVIDER = "vercel";
    assert.equal(configuredSandboxProvider(), "vercel");
  });
});

test("unknown sandbox provider fails closed", () => {
  withCleanEnv(() => {
    process.env.ORVYN_SANDBOX_PROVIDER = "mystery";
    assert.throws(
      () => configuredSandboxProvider(),
      /Unsupported ORVYN_SANDBOX_PROVIDER/
    );
  });
});

test("Vercel provider reports unavailable when server credentials are absent", async () => {
  await withCleanEnv(async () => {
    const provider = new VercelSandboxProvider();
    assert.equal(await provider.available(), false);
  });
});

test("sandbox terminal uses the active provider workspace instead of hard-coded /workspace", async () => {
  const commands: string[] = [];
  const fake: SandboxSession = {
    id: "fake-session",
    provider: "test",
    workspacePath: "/custom/cloud/workspace",
    async exec(command) {
      commands.push(command);
      return {
        ok: true,
        output: "ok",
        exitCode: 0,
        timedOut: false,
      };
    },
    async mergeBack() {
      return { mergedFiles: 0 };
    },
    async stop() {},
  };

  const tool = makeSandboxTerminalTool(fake);
  const result = await tool.execute({
    command: "pwd",
    cwd: "apps/backend",
  });

  assert.equal(result.ok, true);
  assert.equal(commands.length, 1);
  assert.match(commands[0], /\/custom\/cloud\/workspace\/apps\/backend/);
  assert.doesNotMatch(commands[0], /cd \/workspace/);
});
