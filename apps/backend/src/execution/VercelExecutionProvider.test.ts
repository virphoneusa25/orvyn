// apps/backend/src/execution/VercelExecutionProvider.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import {
  VercelExecutionProvider,
  isSnapshotQuotaError,
  reconcileDownloadedWorkspace,
  vercelSandboxName,
} from "./VercelExecutionProvider";
import { SandboxRegistry } from "./sandbox/SandboxRegistry";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const KEYS = [
  "SANDBOX_VERCEL_TOKEN",
  "SANDBOX_VERCEL_TEAM_ID",
  "SANDBOX_VERCEL_PROJECT_ID",
  "VERCEL_TOKEN",
  "VERCEL_TEAM_ID",
  "VERCEL_PROJECT_ID",
] as const;

function withCleanEnv(fn: () => Promise<void> | void): Promise<void> | void {
  const saved = new Map<string, string | undefined>();
  for (const key of KEYS) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }
  const restore = () => {
    for (const key of KEYS) {
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

test("persistent Vercel sandbox names are stable and workspace-scoped", () => {
  const a = vercelSandboxName({
    tenantId: "tenant-a",
    workspaceId: "workspace-1",
    projectId: "project-1",
  });
  const again = vercelSandboxName({
    tenantId: "tenant-a",
    workspaceId: "workspace-1",
    projectId: "project-1",
  });
  const otherTenant = vercelSandboxName({
    tenantId: "tenant-b",
    workspaceId: "workspace-1",
    projectId: "project-1",
  });
  const otherWorkspace = vercelSandboxName({
    tenantId: "tenant-a",
    workspaceId: "workspace-2",
    projectId: "project-1",
  });

  assert.equal(a, again);
  assert.notEqual(a, otherTenant);
  assert.notEqual(a, otherWorkspace);
  assert.match(a, /^orvyn-ws-[a-f0-9]{24}$/);
  assert.equal(a.includes("tenant-a"), false);
  assert.equal(a.includes("workspace-1"), false);
});

test("Vercel cloud provider fails closed when server credentials are absent", async () => {
  await withCleanEnv(async () => {
    const provider = new VercelExecutionProvider();
    const health = await provider.health();
    assert.equal(health.healthy, false);
    assert.match(health.detail ?? "", /auth|credentials/i);
  });
});

test("sandbox registry records Vercel as a first-class provider", () => {
  const dir = mkdtempSync(join(tmpdir(), "orvyn-vercel-registry-"));
  let registry: SandboxRegistry | undefined;
  try {
    registry = new SandboxRegistry(join(dir, "execution.sqlite"));
    const rec = registry.plan({
      id: "sbx_vercel_test",
      provider: "vercel",
      organizationId: "org-test",
      tenantId: "tenant-test",
      userId: "user-test",
      projectId: "project-test",
      workspaceId: "workspace-test",
      runId: "run-test",
      policyTemplate: "code-basic",
      retention: "ephemeral",
    });
    assert.equal(rec.provider, "vercel");

    registry.report(rec.id, {
      state: "ready",
      providerSandboxId: "sbx_provider_native",
      provisionMs: 123,
    });

    const ready = registry.get(rec.id);
    assert.equal(ready?.state, "ready");
    assert.equal(ready?.providerSandboxId, "sbx_provider_native");

    const stats = registry.stats(60_000);
    assert.equal(stats.byProvider.vercel?.created, 1);
    assert.equal(stats.byProvider.vercel?.active, 1);
  } finally {
    registry?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});


test("Vercel workspace sync-back preserves edits, adds files, and applies deletions", async () => {
  const project = mkdtempSync(join(tmpdir(), "orvyn-vercel-project-"));
  const extracted = mkdtempSync(join(tmpdir(), "orvyn-vercel-extracted-"));
  try {
    mkdirSync(join(project, "src"), { recursive: true });
    mkdirSync(join(project, "tmp"), { recursive: true });
    mkdirSync(join(project, "nested", "remove-me"), { recursive: true });
    mkdirSync(join(project, ".git"), { recursive: true });
    writeFileSync(join(project, "src", "keep.txt"), "old\n");
    writeFileSync(join(project, "src", "pipeline-smoke.js"), 'console.log("PIPELINE_OK");\n');
    writeFileSync(join(project, "delete.txt"), "delete me\n");
    writeFileSync(join(project, "nested", "remove-me", "old.txt"), "gone\n");
    writeFileSync(join(project, ".git", "config"), "preserve git metadata\n");
    mkdirSync(join(project, ".git", "objects", "aa"), { recursive: true });
    writeFileSync(join(project, ".git", "objects", "aa", "object"), "original");
    mkdirSync(join(extracted, ".git", "objects", "aa"), { recursive: true });
    writeFileSync(join(extracted, ".git", "objects", "aa", "object"), "sandbox");
    writeFileSync(join(extracted, ".git", "config"), "sandbox config");


    mkdirSync(join(extracted, "src"), { recursive: true });
    mkdirSync(join(extracted, "tmp"), { recursive: true });
    writeFileSync(join(extracted, "src", "keep.txt"), "new\n");
    writeFileSync(join(extracted, "src", "pipeline-smoke.js"), 'console.log("PIPELINE_OK");\n');
    writeFileSync(join(extracted, "tmp", "recovery-probe.js"), 'console.log("RECOVERY_OK");\n');
    writeFileSync(join(extracted, "created.txt"), "created\n");

    const files = await reconcileDownloadedWorkspace(project, extracted);

    assert.equal(readFileSync(join(project, "src", "keep.txt"), "utf8"), "new\n");
    assert.equal(readFileSync(join(project, "created.txt"), "utf8"), "created\n");
    assert.equal(readFileSync(join(project, "src", "pipeline-smoke.js"), "utf8"), 'console.log("PIPELINE_OK");\n');
    assert.equal(readFileSync(join(project, "tmp", "recovery-probe.js"), "utf8"), 'console.log("RECOVERY_OK");\n');
    assert.equal(existsSync(join(project, "delete.txt")), false);
    assert.equal(existsSync(join(project, "nested", "remove-me", "old.txt")), false);
    assert.equal(existsSync(join(project, "nested", "remove-me")), false);
    assert.equal(
      readFileSync(join(project, ".git", "config"), "utf8"),
      "preserve git metadata\n"
    );
    assert.equal(readFileSync(join(project, ".git", "objects", "aa", "object"), "utf8"), "original");
    assert.deepEqual(files.sort(), ["created.txt", "src/keep.txt", "src/pipeline-smoke.js", "tmp/recovery-probe.js"]);
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(extracted, { recursive: true, force: true });
  }
});


// ── Snapshot storage quota fallback ─────────────────────────────────────

function fakeSandbox(id: string) {
  return {
    sandboxId: id,
    writeFiles: async () => undefined,
    runCommand: async () => ({ exitCode: 0, stdout: async () => "", stderr: async () => "" }),
    stop: async () => undefined,
  };
}

async function withStubbedSandbox(
  stubs: { getOrCreate: (opts: any) => Promise<any>; create: (opts: any) => Promise<any> },
  fn: () => Promise<void>
): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { Sandbox } = require("@vercel/sandbox");
  const original = { getOrCreate: Sandbox.getOrCreate, create: Sandbox.create };
  const savedEnv = new Map<string, string | undefined>();
  const env: Record<string, string> = {
    SANDBOX_VERCEL_TOKEN: "test-token",
    SANDBOX_VERCEL_TEAM_ID: "team_test",
    SANDBOX_VERCEL_PROJECT_ID: "prj_test",
    ORVYN_VERCEL_PERSISTENT_WORKSPACES: "true",
  };
  for (const [k, v] of Object.entries(env)) {
    savedEnv.set(k, process.env[k]);
    process.env[k] = v;
  }
  const savedOidc = process.env.VERCEL_OIDC_TOKEN;
  delete process.env.VERCEL_OIDC_TOKEN;
  Sandbox.getOrCreate = stubs.getOrCreate;
  Sandbox.create = stubs.create;
  try {
    await fn();
  } finally {
    Sandbox.getOrCreate = original.getOrCreate;
    Sandbox.create = original.create;
    for (const [k, v] of savedEnv) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    if (savedOidc !== undefined) process.env.VERCEL_OIDC_TOKEN = savedOidc;
  }
}

const identity = { tenantId: "tenant-q", workspaceId: "ws-q", projectId: "prj-q" };

test("isSnapshotQuotaError recognises Vercel Hobby snapshot storage 402s only", () => {
  assert.equal(
    isSnapshotQuotaError(
      new Error(
        "Status code 402 is not ok: Hobby plan usage limit exceeded for Snapshots Storage."
      )
    ),
    true
  );
  assert.equal(isSnapshotQuotaError({ status: 402, message: "Payment required" }), true);
  assert.equal(isSnapshotQuotaError(new Error("snapshot quota reached")), true);
  assert.equal(isSnapshotQuotaError(new Error("Status code 401 is not ok: unauthorized")), false);
  assert.equal(isSnapshotQuotaError(new Error("ECONNRESET")), false);
});

test("persistent sandbox requests bound snapshot retention", async () => {
  const project = mkdtempSync(join(tmpdir(), "orvyn-vercel-keep-"));
  writeFileSync(join(project, "a.txt"), "a\n");
  let seen: any;
  try {
    await withStubbedSandbox(
      {
        getOrCreate: async (opts) => {
          seen = opts;
          return fakeSandbox("sbx_persistent");
        },
        create: async () => {
          throw new Error("create should not be called");
        },
      },
      async () => {
        const provider = new VercelExecutionProvider();
        await provider.startRun("run-keep", project, identity);
        assert.equal(provider.isPersistent("run-keep"), true);
        assert.equal(provider.sandboxName("run-keep"), vercelSandboxName(identity));
        await provider.stopRun("run-keep");
      }
    );
    assert.equal(seen.persistent, true);
    assert.deepEqual(seen.keepLastSnapshots, { count: 1, deleteEvicted: true });
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("snapshot storage quota falls back to an ephemeral Vercel sandbox, not another environment", async () => {
  const project = mkdtempSync(join(tmpdir(), "orvyn-vercel-quota-"));
  writeFileSync(join(project, "a.txt"), "a\n");
  let createOpts: any;
  try {
    await withStubbedSandbox(
      {
        getOrCreate: async () => {
          throw new Error(
            "Status code 402 is not ok: Hobby plan usage limit exceeded for Snapshots Storage."
          );
        },
        create: async (opts) => {
          createOpts = opts;
          return fakeSandbox("sbx_ephemeral");
        },
      },
      async () => {
        const provider = new VercelExecutionProvider();
        await provider.startRun("run-quota", project, identity);
        assert.equal(provider.location, "VERCEL_CLOUD");
        assert.equal(provider.isPersistent("run-quota"), false);
        assert.equal(provider.sandboxName("run-quota"), undefined);
        assert.equal(provider.sandboxId("run-quota"), "sbx_ephemeral");
        await provider.stopRun("run-quota");

        // Lease must be released so a later run can retry persistence.
        await provider.startRun("run-quota-2", project, identity);
        assert.equal(provider.sandboxId("run-quota-2"), "sbx_ephemeral");
        await provider.stopRun("run-quota-2");
      }
    );
    assert.equal(createOpts.persistent, false);
    assert.equal(createOpts.env.ORVYN_EXECUTION_LOCATION, "VERCEL_CLOUD");
    assert.equal(createOpts.env.ORVYN_RUN_ID, "run-quota-2");
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("non-quota persistent sandbox failures still fail closed", async () => {
  const project = mkdtempSync(join(tmpdir(), "orvyn-vercel-fail-"));
  writeFileSync(join(project, "a.txt"), "a\n");
  let createCalls = 0;
  try {
    await withStubbedSandbox(
      {
        getOrCreate: async () => {
          throw new Error("Status code 401 is not ok: unauthorized");
        },
        create: async () => {
          createCalls++;
          return fakeSandbox("sbx_never");
        },
      },
      async () => {
        const provider = new VercelExecutionProvider();
        await assert.rejects(provider.startRun("run-401", project, identity), /401/);
        assert.equal(provider.sandboxId("run-401"), undefined);
      }
    );
    assert.equal(createCalls, 0);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});


test("Vercel workspace sync-back handles empty or missing projectRoot safely", async () => {
  const extracted = mkdtempSync(join(tmpdir(), "orvyn-vercel-extracted-empty-"));
  try {
    writeFileSync(join(extracted, "created.txt"), "hello\n");
    const emptyResult = await reconcileDownloadedWorkspace("", extracted);
    assert.deepEqual(emptyResult, []);

    const nonExistentResult = await reconcileDownloadedWorkspace("/path/does/not/exist", extracted);
    assert.deepEqual(nonExistentResult, []);
  } finally {
    rmSync(extracted, { recursive: true, force: true });
  }
});

test("Vercel cloud provider safely initializes empty workspace for repo-free / browser tasks", async () => {
  let writtenFiles: any[] = [];
  let executedCommands: string[] = [];

  await withStubbedSandbox(
    {
      getOrCreate: async () => {
        return {
          id: "sbx_repo_free",
          writeFiles: async (files: any[]) => {
            writtenFiles.push(...files);
          },
          runCommand: async (cmd: any) => {
            const command = cmd.args.join(" ");
            executedCommands.push(command);
            // downloadArtifacts expects a base64-encoded tar stream from the
            // sandbox. Empty stdout means corrupt export data, not an empty workspace.
            const stdout = command.includes("base64 -w0")
              ? Buffer.alloc(1024, 0).toString("base64")
              : "";
            return {
              exitCode: 0,
              stdout: async () => stdout,
              stderr: async () => "",
            };
          },
          stop: async () => {},
        };
      },
      create: async () => {
        throw new Error("unexpected create call");
      },
    },
    async () => {
      const provider = new VercelExecutionProvider();
      // startRun with empty string projectRoot (website review / browser research)
      await provider.startRun("run-repo-free", "", identity);
      assert.equal(provider.sandboxId("run-repo-free"), "sbx_repo_free");

      // Verify empty tar was uploaded safely without tar error
      assert.equal(writtenFiles.length, 1);
      assert.equal(writtenFiles[0].path, "/vercel/sandbox/orvyn-workspace.tar");
      assert.equal(Buffer.isBuffer(writtenFiles[0].content), true);
      assert.equal(writtenFiles[0].content.length, 1024);

      // Verify tar extraction command ran cleanly
      assert.ok(executedCommands.some((c) => c.includes("tar xf '/vercel/sandbox/orvyn-workspace.tar'")));

      // downloadArtifacts on empty projectRoot returns empty files array without failing
      const dl = await provider.downloadArtifacts("run-repo-free");
      assert.deepEqual(dl, { files: [] });

      await provider.stopRun("run-repo-free");
      assert.equal(provider.sandboxId("run-repo-free"), undefined);
    }
  );
});
