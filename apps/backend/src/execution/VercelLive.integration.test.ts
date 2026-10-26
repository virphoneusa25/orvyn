// apps/backend/src/execution/VercelLive.integration.test.ts
//
// Manual live Vercel Sandbox parity test.
// Runs only when ORVYN_VERCEL_LIVE_TEST=1 and real Vercel credentials exist.
// It deliberately exercises the SAME ToolRpc/VercelToolRunner/Desktop path
// ORION uses instead of testing the SDK in isolation.

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { RunStore } from "../agent/events";
import { toolRpc } from "./ToolRpc";
import { vercelToolRunner } from "./VercelToolRunner";
import {
  captureVercelDesktopFrame,
  startVercelDesktop,
  stopVercelDesktop,
  vercelDesktopInput,
} from "../desktop/vercelDesktop";

const live =
  process.env.ORVYN_VERCEL_LIVE_TEST === "1" &&
  Boolean(
    (process.env.SANDBOX_VERCEL_TOKEN || process.env.VERCEL_TOKEN) &&
      (process.env.SANDBOX_VERCEL_TEAM_ID || process.env.VERCEL_TEAM_ID) &&
      (process.env.SANDBOX_VERCEL_PROJECT_ID || process.env.VERCEL_PROJECT_ID)
  );

test(
  "live Vercel: ORION ToolRpc browser MCP desktop and sync-back parity",
  { skip: !live, timeout: 15 * 60_000 },
  async () => {
    const root = mkdtempSync(join(tmpdir(), "orvyn-vercel-live-"));
    const runId = "run_vercel_live_" + Date.now().toString(36);
    const tenantId = "tenant-vercel-live";
    const store = new RunStore();
    store.create(runId, root, "running");

    mkdirSync(join(root, ".orvyn"), { recursive: true });
    writeFileSync(join(root, "seed.txt"), "seed\n");

    // Tiny stdio MCP server fixture using the line-delimited JSON-RPC contract
    // already supported by ORVYN's sandbox MCP bridge.
    writeFileSync(
      join(root, "mcp-fixture.mjs"),
      [
        'import readline from "node:readline";',
        'const rl=readline.createInterface({input:process.stdin});',
        'function send(x){process.stdout.write(JSON.stringify(x)+"\\n")}',
        'rl.on("line",(line)=>{',
        '  let m; try{m=JSON.parse(line)}catch{return}',
        '  if(!m.id)return;',
        '  if(m.method==="initialize") return send({jsonrpc:"2.0",id:m.id,result:{protocolVersion:"2025-03-26",capabilities:{tools:{}},serverInfo:{name:"fixture",version:"1"}}});',
        '  if(m.method==="tools/list") return send({jsonrpc:"2.0",id:m.id,result:{tools:[{name:"echo",description:"echo fixture",inputSchema:{type:"object"}}]}});',
        '  if(m.method==="tools/call") return send({jsonrpc:"2.0",id:m.id,result:{content:[{type:"text",text:"echo:"+JSON.stringify(m.params?.arguments??{})}]}});',
        '  send({jsonrpc:"2.0",id:m.id,result:{}});',
        '});',
      ].join("\n")
    );
    writeFileSync(
      join(root, ".orvyn", "mcp.json"),
      JSON.stringify(
        {
          servers: {
            fixture: {
              command: "node",
              args: ["/vercel/sandbox/workspace/mcp-fixture.mjs"],
            },
          },
        },
        null,
        2
      )
    );

    execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "live-test@orvyn.invalid"], {
      cwd: root,
      stdio: "ignore",
    });
    execFileSync("git", ["config", "user.name", "ORVYN Live Test"], {
      cwd: root,
      stdio: "ignore",
    });
    execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "seed"], {
      cwd: root,
      stdio: "ignore",
    });

    let desktop:
      | Awaited<ReturnType<typeof startVercelDesktop>>
      | undefined;

    try {
      await vercelToolRunner.start(runId, root, store, {
        tenantId,
        organizationId: "org-vercel-live",
        userId: "user-vercel-live",
        projectId: "project-vercel-live",
        workspaceId: "workspace-vercel-live",
      });

      const firstSandboxName = vercelToolRunner.provider.sandboxName(runId);
      assert.equal(
        vercelToolRunner.provider.isPersistent(runId),
        true,
        "expected persistent Vercel sandbox; sandboxName=" +
          String(firstSandboxName ?? "(none)")
      );
      assert.ok(firstSandboxName, "live Vercel run should use a named persistent sandbox");

      const pwd = await toolRpc.execute(runId, "terminal", {
        command: "pwd",
      }, 60_000, tenantId);
      assert.equal(
        pwd.ok,
        true,
        "terminal pwd failed: " + JSON.stringify({
          output: pwd.output,
          error: pwd.error,
          stderr: pwd.stderr,
          exitCode: pwd.exitCode,
        })
      );
      assert.match(pwd.output ?? "", /\/vercel\/sandbox\/workspace/);

      const write = await toolRpc.execute(runId, "write_file", {
        path: "created-by-vercel.txt",
        content: "hello from ORVYN Vercel cloud\n",
      }, 60_000, tenantId);
      assert.equal(
        write.ok,
        true,
        "write_file failed: " + JSON.stringify({
          output: write.output,
          error: write.error,
          stderr: write.stderr,
          exitCode: write.exitCode,
        })
      );

      const read = await toolRpc.execute(runId, "read_file", {
        path: "created-by-vercel.txt",
      }, 60_000, tenantId);
      assert.equal(
        read.ok,
        true,
        "read_file failed: " + JSON.stringify({
          output: read.output,
          error: read.error,
          stderr: read.stderr,
          exitCode: read.exitCode,
        })
      );
      assert.match(read.output ?? "", /hello from ORVYN Vercel cloud/);

      const git = await toolRpc.execute(runId, "git_status", {}, 60_000, tenantId);
      assert.equal(git.ok, true, "git_status failed: " + JSON.stringify(git));
      assert.match(git.output ?? "", /created-by-vercel\.txt/);

      const mcpList = await toolRpc.execute(
        runId,
        "mcp_list",
        {},
        90_000,
        tenantId
      );
      assert.equal(mcpList.ok, true, "mcp_list failed: " + JSON.stringify(mcpList));
      assert.match(mcpList.output ?? "", /fixture:/);
      assert.match(mcpList.output ?? "", /echo/);

      const mcpCall = await toolRpc.execute(
        runId,
        "mcp_call",
        {
          server: "fixture",
          tool: "echo",
          arguments: { value: 42 },
        },
        90_000,
        tenantId
      );
      assert.equal(mcpCall.ok, true, "mcp_call failed: " + JSON.stringify(mcpCall));
      assert.match(mcpCall.output ?? "", /42/);

      const browser = await toolRpc.execute(
        runId,
        "browser_open",
        { url: "https://example.com" },
        6 * 60_000,
        tenantId
      );
      assert.equal(browser.ok, true, "browser_open failed: " + JSON.stringify(browser));
      assert.match(browser.output ?? "", /Example Domain|example\.com/i);

      const screenshot = await toolRpc.execute(
        runId,
        "browser_screenshot",
        {},
        90_000,
        tenantId
      );
      assert.equal(screenshot.ok, true, "browser_screenshot failed: " + JSON.stringify({ output: screenshot.output, error: screenshot.error, stderr: screenshot.stderr, exitCode: screenshot.exitCode, metaKeys: screenshot.meta ? Object.keys(screenshot.meta as any) : [] }));
      const b64 = String(
        (screenshot.meta as any)?.screenshot?.b64 ?? ""
      );
      assert.ok(
        Buffer.from(b64, "base64").length > 1000,
        "browser screenshot should contain real PNG bytes"
      );

      desktop = await startVercelDesktop({
        tenantId,
        projectRoot: root,
        runId,
        url: "https://example.com",
        width: 1280,
        height: 800,
      });
      assert.equal(desktop.status, "ready");
      assert.ok(desktop.resources.vcpus >= 1);
      assert.ok(desktop.resources.memoryMb > 0);

      const frame = await captureVercelDesktopFrame(desktop, "low");
      assert.ok(frame && frame.length > 1000, "desktop should return a real JPEG frame");

      assert.equal(
        await vercelDesktopInput(
          desktop,
          "key",
          { key: "Escape" },
          "orion"
        ),
        true
      );

      await stopVercelDesktop(desktop);
      desktop = undefined;

      const probe = await vercelToolRunner.execRaw(
        runId,
        "printf %s persistent-ok > /vercel/sandbox/.orvyn-persistence-probe"
      );
      assert.equal(probe.ok, true, "persistence probe failed: " + JSON.stringify(probe));

      store.setStatus(runId, "completed");
      await vercelToolRunner.stop(runId, "live smoke complete");

      assert.match(
        readFileSync(join(root, "created-by-vercel.txt"), "utf8"),
        /hello from ORVYN Vercel cloud/
      );

      // Resume a second ORVYN mission against the same durable workspace.
      // The sandbox-level probe must survive, while project files are rebuilt
      // from canonical ORVYN state before the new mission begins.
      writeFileSync(join(root, "seed.txt"), "seed updated locally\n");
      const resumeRunId = runId + "_resume";
      store.create(resumeRunId, root, "running");
      await vercelToolRunner.start(resumeRunId, root, store, {
        tenantId,
        organizationId: "org-vercel-live",
        userId: "user-vercel-live",
        projectId: "project-vercel-live",
        workspaceId: "workspace-vercel-live",
      });

      assert.equal(vercelToolRunner.provider.isPersistent(resumeRunId), true);
      assert.equal(
        vercelToolRunner.provider.sandboxName(resumeRunId),
        firstSandboxName
      );

      const resumedProbe = await vercelToolRunner.execRaw(
        resumeRunId,
        "cat /vercel/sandbox/.orvyn-persistence-probe"
      );
      assert.equal(resumedProbe.ok, true, "resumed persistence probe failed: " + JSON.stringify(resumedProbe));
      assert.match(resumedProbe.output, /persistent-ok/);

      const canonicalSeed = await toolRpc.execute(resumeRunId, "read_file", {
        path: "seed.txt",
      }, 60_000, tenantId);
      assert.equal(canonicalSeed.ok, true, "canonical seed read failed: " + JSON.stringify(canonicalSeed));
      assert.match(canonicalSeed.output ?? "", /seed updated locally/);

      store.setStatus(resumeRunId, "completed");
      await vercelToolRunner.stop(resumeRunId, "live resume smoke complete");
    } finally {
      if (desktop) {
        await stopVercelDesktop(desktop).catch(() => undefined);
      }
      await vercelToolRunner.stop(runId, "live test cleanup").catch(
        () => undefined
      );
      rmSync(root, { recursive: true, force: true });
    }
  }
);
