// apps/backend/src/execution/VercelToolRunner.ts
//
// Executes ORION's existing RemoteToolAdapter / ToolRpc requests directly
// against a run-scoped Vercel Sandbox. The model loop and credentials remain
// on the ORVYN control plane; only approved tool actions enter the microVM.

import { promises as fs } from "fs";
import * as path from "path";
import { defaultDataDir } from "../persistence/LocalStore";
import type { RunStore } from "../agent/events";
import { toolRpc, type ToolRequest, type ToolResponse } from "./ToolRpc";
import { sandboxRegistry } from "./sandbox/SandboxRegistry";
import { VercelExecutionProvider } from "./VercelExecutionProvider";
import {
  VERCEL_BROWSER_PORT,
  VERCEL_BROWSER_SERVER_SOURCE,
} from "./VercelBrowserRuntime";
import {
  UpstreamAgentBrowserProvider,
  createSandboxSessionLike,
  isUpstreamEnabledFor,
  buildSessionName,
} from "./UpstreamAgentBrowserProvider";
import {
  VERCEL_MCP_PORT,
  VERCEL_MCP_SERVER_SOURCE,
} from "./VercelMcpRuntime";

const WORKSPACE = "/vercel/sandbox/workspace";
const POLL_MS = 100;

type Identity = {
  tenantId: string;
  organizationId: string;
  userId: string;
  userEmail?: string;
  projectId: string | null;
  workspaceId: string;
};

type ProcessEntry = {
  id: string;
  pid: number;
  command: string;
  cwd: string;
  log: string;
  startedAt: number;
};

type RunEntry = {
  projectRoot: string;
  store: RunStore;
  identity: Identity;
  stopping: boolean;
  stopPromise?: Promise<void>;
  processes: Map<string, ProcessEntry>;
  browserReady: boolean;
  browserProvisioning?: Promise<void>;
  upstreamBrowser?: UpstreamAgentBrowserProvider;
  upstreamBrowserReady?: boolean;
  upstreamBrowserProvisioning?: Promise<void>;
  upstreamBrowserSessionId?: string;
  mcpReady: boolean;
  mcpProvisioning?: Promise<void>;
  loop: Promise<void>;
};

function shellQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

function safeRel(raw: unknown): string | null {
  let rel = String(raw ?? "").trim().replace(/\\/g, "/").replace(/^\.\//, "");
  try { rel = decodeURIComponent(rel); } catch { return null; }
  rel = rel.replace(/^\/+/, "").replace(/\0/g, "");
  if (!rel || rel === ".") return "";
  if (/^[A-Za-z]:\//.test(rel) || rel.startsWith("~") || rel.startsWith("//")) return null;
  const parts = rel.split("/").filter((p) => p && p !== ".");
  if (parts.some((p) => p === ".." || p === "~")) return null;
  return parts.join("/");
}

function absoluteWorkspacePath(raw: unknown): string | null {
  const rel = safeRel(raw);
  if (rel === null) return null;
  return rel ? WORKSPACE + "/" + rel : WORKSPACE;
}

function response(
  request: ToolRequest,
  startedAt: number,
  value: Partial<ToolResponse>
): ToolResponse {
  return {
    requestId: request.requestId,
    runId: request.runId,
    ok: value.ok === true,
    durationMs: Date.now() - startedAt,
    ...(value.output !== undefined ? { output: value.output } : {}),
    ...(value.stderr !== undefined ? { stderr: value.stderr } : {}),
    ...(value.exitCode !== undefined ? { exitCode: value.exitCode } : {}),
    ...(value.error !== undefined ? { error: value.error } : {}),
    ...(value.meta !== undefined ? { meta: value.meta } : {}),
  };
}

function jsonOrText(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

export class VercelToolRunner {
  private runs = new Map<string, RunEntry>();

  constructor(
    readonly provider = new VercelExecutionProvider()
  ) {}

  async health(): Promise<{ healthy: boolean; detail?: string }> {
    return this.provider.health();
  }

  async executeRequest(request: ToolRequest): Promise<ToolResponse> {
    const entry = this.runs.get(request.runId);
    if (!entry) {
      return response(request, request.createdAt, {
        ok: false,
        error: "No active runner for run " + request.runId,
        exitCode: 1,
      });
    }
    return this.execute(request, entry);
  }

  hasRun(runId: string): boolean {
    return this.runs.has(runId);
  }

  projectRoot(runId: string): string | undefined {
    return this.runs.get(runId)?.projectRoot;
  }

  async execRaw(
    runId: string,
    command: string,
    opts: { cwd?: string; timeoutS?: number } = {}
  ) {
    if (!this.runs.has(runId)) {
      return {
        ok: false,
        output: "No Vercel Sandbox exists for this run.",
        exitCode: -1,
      };
    }
    return this.command(runId, command, opts.cwd, opts.timeoutS);
  }

  async start(
    runId: string,
    projectRoot: string,
    store: RunStore,
    identity: Identity
  ): Promise<void> {
    if (this.runs.has(runId)) return;

    const registry = sandboxRegistry();
    const logicalId = "sbx_vercel_" + runId.replace(/[^A-Za-z0-9]/g, "").slice(0, 24);
    registry.plan({
      id: logicalId,
      provider: "vercel",
      organizationId: identity.organizationId,
      tenantId: identity.tenantId,
      userId: identity.userId,
      projectId: identity.projectId,
      workspaceId: identity.workspaceId,
      runId,
      policyTemplate: "code-basic",
      retention: "ephemeral",
      expiresAt: Date.now() + (Number(process.env.ORVYN_SANDBOX_TIMEOUT_MIN) || 30) * 60_000,
    });

    let effectiveProjectRoot = typeof projectRoot === "string" ? projectRoot.trim() : "";
    if (!effectiveProjectRoot) {
      const ephemeralBase = path.join(defaultDataDir(), "tenants", identity.tenantId || "default", "ephemeral");
      effectiveProjectRoot = path.join(ephemeralBase, runId);
      await fs.mkdir(effectiveProjectRoot, { recursive: true }).catch(() => undefined);
    }

    const startedAt = Date.now();
    try {
      await this.provider.startRun(runId, effectiveProjectRoot, {
        tenantId: identity.tenantId,
        workspaceId: identity.workspaceId,
        projectId: identity.projectId,
      });
      const providerSandboxId = this.provider.sandboxId(runId) ?? null;
      registry.report(logicalId, {
        state: "ready",
        providerSandboxId,
        provisionMs: Date.now() - startedAt,
      });
      registry.audit("sandbox.ready", "vercel-runner", {
        sandboxId: logicalId,
        organizationId: identity.organizationId,
        detail: { provider: "vercel", provisionMs: Date.now() - startedAt },
      });
      store.emit(runId, "sandbox.ready", {
        provider: "vercel",
        sandboxId: logicalId,
        providerSandboxId,
        sandboxName: this.provider.sandboxName(runId),
        persistent: this.provider.isPersistent(runId),
        workspace: WORKSPACE,
      });

      const entry: RunEntry = {
        projectRoot: effectiveProjectRoot,
        store,
        identity,
        stopping: false,
        processes: new Map(),
        browserReady: false,
        mcpReady: false,
        loop: Promise.resolve(),
      };
      this.runs.set(runId, entry);
      entry.loop = this.serve(runId, entry);
    } catch (err: any) {
      registry.report(logicalId, {
        state: "failed",
        lastError: err?.message ?? String(err),
        destroyedAt: Date.now(),
      });
      registry.audit("sandbox.failed", "vercel-runner", {
        sandboxId: logicalId,
        organizationId: identity.organizationId,
        detail: { error: String(err?.message ?? err).slice(0, 300) },
      });
      store.emit(runId, "sandbox.stopped", {
        provider: "vercel",
        reason: err?.message ?? String(err),
      });
      throw err;
    }
  }

  private async serve(runId: string, entry: RunEntry): Promise<void> {
    try {
      while (!entry.stopping) {
        const run = entry.store.get(runId);
        if (!run || ["completed", "cancelled", "error", "partial"].includes(run.status)) break;

        const request = toolRpc.poll(runId);
        if (!request) {
          await new Promise((resolve) => setTimeout(resolve, POLL_MS));
          continue;
        }

        const result = await this.execute(request, entry).catch((err: any) =>
          response(request, request.createdAt, {
            ok: false,
            error: err?.message ?? String(err),
            exitCode: 1,
          })
        );
        toolRpc.resolve(result);
      }
    } finally {
      await this.stop(runId, "run ended").catch(() => undefined);
    }
  }

  async stop(runId: string, reason = "stopped"): Promise<void> {
    const entry = this.runs.get(runId);
    if (!entry) return;

    // Shutdown can be triggered concurrently by the polling loop (when the
    // run status becomes terminal) and by explicit callers. Every caller must
    // await the same stop promise so durable sync-back is complete before stop()
    // resolves.
    if (entry.stopPromise) {
      await entry.stopPromise;
      return;
    }

    entry.stopping = true;
    entry.stopPromise = (async () => {
      if (entry.upstreamBrowser) {
        await entry.upstreamBrowser.closeSession().catch(() => undefined);
      }
      let syncError: Error | undefined;
      try {
        await this.provider.downloadArtifacts(runId);
      } catch (err: any) {
        syncError =
          err instanceof Error ? err : new Error(String(err?.message ?? err));
        entry.store.emit(runId, "sandbox.sync.failed", {
          provider: "vercel",
          error: syncError.message.slice(0, 500),
        });
      }

      await this.provider.stopRun(runId).catch(() => undefined);
      toolRpc.failRun(runId, "The Vercel cloud sandbox ended before this tool completed.");

      const registry = sandboxRegistry();
      const rec = registry.forRun(runId);
      if (rec?.provider === "vercel") {
        registry.report(rec.id, {
          state: syncError
            ? "failed"
            : reason === "run ended"
              ? "completed"
              : "stopped",
          destroyedAt: Date.now(),
        });
        registry.audit("sandbox.destroyed", "vercel-runner", {
          sandboxId: rec.id,
          organizationId: rec.organizationId,
          detail: {
            reason,
            ...(syncError ? { syncError: syncError.message.slice(0, 500) } : {}),
          },
        });
      }

      entry.store.emit(runId, "sandbox.stopped", {
        provider: "vercel",
        reason,
        syncOk: !syncError,
      });
      this.runs.delete(runId);

      if (syncError) {
        throw new Error("Vercel durable sync-back failed: " + syncError.message);
      }
    })();

    await entry.stopPromise;
  }

  private async command(
    runId: string,
    command: string,
    cwd?: string,
    timeoutS?: number
  ): Promise<{ ok: boolean; output: string; exitCode?: number; timedOut?: boolean }> {
    return this.provider.executeCommand(runId, command, { cwd, timeoutS });
  }

  private async readFile(runId: string, rawPath: unknown, base64 = false) {
    const target = absoluteWorkspacePath(rawPath);
    if (!target || target === WORKSPACE) {
      return { ok: false, error: "path must name a file inside the workspace", exitCode: 1 };
    }
    const cmd = base64
      ? "base64 -w0 " + shellQuote(target)
      : "cat -- " + shellQuote(target);
    const r = await this.command(runId, cmd);
    return r.ok
      ? { ok: true, output: r.output, exitCode: r.exitCode }
      : { ok: false, error: r.output, exitCode: r.exitCode };
  }

  private async writeFile(
    runId: string,
    rawPath: unknown,
    content: string,
    append: boolean
  ) {
    const target = absoluteWorkspacePath(rawPath);
    if (!target || target === WORKSPACE) {
      return { ok: false, error: "path must name a file inside the workspace", exitCode: 1 };
    }
    const encoded = Buffer.from(content, "utf8").toString("base64");
    const redirect = append ? ">>" : ">";
    const cmd =
      "mkdir -p " + shellQuote(target.split("/").slice(0, -1).join("/")) +
      " && printf %s " + shellQuote(encoded) +
      " | base64 -d " + redirect + " " + shellQuote(target);
    const r = await this.command(runId, cmd);
    return r.ok
      ? {
          ok: true,
          output: JSON.stringify({
            ok: true,
            path: safeRel(rawPath),
            bytesWritten: Buffer.byteLength(content, "utf8"),
          }),
          exitCode: r.exitCode,
        }
      : { ok: false, error: r.output, exitCode: r.exitCode };
  }

  private async editFile(
    runId: string,
    rawPath: unknown,
    oldString: string,
    newString: string,
    replaceAll: boolean
  ) {
    const target = absoluteWorkspacePath(rawPath);
    if (!target || target === WORKSPACE) {
      return { ok: false, error: "path must name a file inside the workspace", exitCode: 1 };
    }
    if (!oldString) return { ok: false, error: "old_string must not be empty", exitCode: 1 };

    const script = [
      "const fs=require('fs');",
      "const p=Buffer.from(process.argv[1],'base64').toString();",
      "const old=Buffer.from(process.argv[2],'base64').toString();",
      "const neu=Buffer.from(process.argv[3],'base64').toString();",
      "const all=process.argv[4]==='1';",
      "let s=fs.readFileSync(p,'utf8');",
      "const n=s.split(old).length-1;",
      "if(!n){console.error('old_string not found in '+p);process.exit(4)}",
      "if(n>1&&!all){console.error('old_string matched '+n+' times; include more context or set replace_all');process.exit(5)}",
      "s=all?s.split(old).join(neu):s.replace(old,neu);",
      "fs.writeFileSync(p,s);",
      "console.log('Edited '+p);",
    ].join("");

    const args = [
      Buffer.from(target).toString("base64"),
      Buffer.from(oldString).toString("base64"),
      Buffer.from(newString).toString("base64"),
      replaceAll ? "1" : "0",
    ];
    const cmd = "node -e " + shellQuote(script) + " " + args.map(shellQuote).join(" ");
    const r = await this.command(runId, cmd);
    return r.ok
      ? { ok: true, output: r.output, exitCode: r.exitCode }
      : { ok: false, error: r.output, exitCode: r.exitCode };
  }

  private async startProcess(runId: string, entry: RunEntry, args: Record<string, unknown>) {
    const command = String(args.command ?? "").trim();
    if (!command) return { ok: false, error: "command is required", exitCode: 1 };
    const cwd = safeRel(args.cwd);
    if (cwd === null) return { ok: false, error: "cwd escapes the workspace", exitCode: 1 };

    const id = "proc_" + Math.random().toString(36).slice(2, 10);
    const log = "/tmp/orvyn-" + id + ".log";
    const workdir = cwd ? WORKSPACE + "/" + cwd : WORKSPACE;
    const launch =
      "cd " + shellQuote(workdir) +
      " && nohup sh -lc " + shellQuote(command) +
      " >" + shellQuote(log) + " 2>&1 </dev/null & echo $!";
    const r = await this.command(runId, launch);
    const pid = Number((r.output || "").trim().split(/\s+/).pop());
    if (!r.ok || !Number.isFinite(pid)) {
      return { ok: false, error: r.output || "process failed to start", exitCode: r.exitCode };
    }
    entry.processes.set(id, { id, pid, command, cwd: cwd ?? "", log, startedAt: Date.now() });
    return {
      ok: true,
      output: JSON.stringify({ id, pid, command, status: "running" }),
      meta: { processId: id, pid },
      exitCode: 0,
    };
  }

  private async processTool(runId: string, entry: RunEntry, request: ToolRequest) {
    const id = String(request.arguments.id ?? request.arguments.processId ?? "");
    const proc = entry.processes.get(id);
    if (!proc) return { ok: false, error: "Unknown sandbox process: " + id, exitCode: 1 };

    if (request.tool === "stop_process") {
      await this.command(runId, "kill " + proc.pid + " 2>/dev/null || true");
      entry.processes.delete(id);
      return { ok: true, output: "Stopped " + id, exitCode: 0 };
    }
    if (request.tool === "read_process_logs") {
      const tail = Math.min(Math.max(Number(request.arguments.tail) || 80, 1), 500);
      const r = await this.command(runId, "tail -n " + tail + " " + shellQuote(proc.log) + " 2>/dev/null || true");
      return { ok: true, output: r.output, exitCode: 0 };
    }
    return { ok: false, error: "Unsupported process operation", exitCode: 1 };
  }

  private async ensureBrowser(runId: string, entry: RunEntry): Promise<void> {
    if (entry.browserReady) return;
    if (entry.browserProvisioning) return entry.browserProvisioning;

    entry.browserProvisioning = (async () => {
      entry.store.emit(runId, "browser.provisioning", {
        provider: "vercel",
        note: "Preparing the run-scoped ORVYN Cloud browser",
      });

      const root = "/tmp/orvyn-browser";
      const scriptPath = root + "/server.mjs";
      const encoded = Buffer.from(
        VERCEL_BROWSER_SERVER_SOURCE,
        "utf8"
      ).toString("base64");

      const playwrightMarker = root + "/.orvyn-playwright-1.63.0-ready";
      const install = [
        "mkdir -p " + shellQuote(root),
        "printf %s " + shellQuote(encoded) + " | base64 -d > " + shellQuote(scriptPath),
        "cd " + shellQuote(root),
        "test -f package.json || npm init -y >/dev/null 2>&1",
        "if [ ! -f " + shellQuote(playwrightMarker) + " ]; then " +
          "npm install --silent --no-audit --no-fund playwright@1.63.0 && " +
          "npx playwright install --with-deps chromium >/tmp/orvyn-playwright-install.log 2>&1 && " +
          "touch " + shellQuote(playwrightMarker) + "; fi",
      ].join(" && ");

      const installed = await this.command(runId, install, "", 300);
      if (!installed.ok) {
        const logs = await this.command(
          runId,
          "tail -n 120 /tmp/orvyn-playwright-install.log 2>/dev/null || true"
        );
        throw new Error(
          "Could not provision ORVYN Cloud browser: " +
            (logs.output || installed.output).slice(0, 3000)
        );
      }

      const launch = await this.command(
        runId,
        "cd " +
          shellQuote(root) +
          " && nohup node " +
          shellQuote(scriptPath) +
          " >/tmp/orvyn-browser.log 2>&1 </dev/null & echo $!"
      );
      if (!launch.ok) {
        throw new Error("Could not start ORVYN Cloud browser: " + launch.output);
      }

      const wait = await this.command(
        runId,
        "for i in $(seq 1 90); do " +
          "curl -fsS http://127.0.0.1:" +
          VERCEL_BROWSER_PORT +
          "/health >/dev/null && exit 0; " +
          "sleep 1; " +
          "done; tail -n 160 /tmp/orvyn-browser.log 2>/dev/null; exit 1",
        "",
        120
      );
      if (!wait.ok) {
        throw new Error(
          "ORVYN Cloud browser did not become ready: " +
            wait.output.slice(0, 3000)
        );
      }

      entry.browserReady = true;
      entry.store.emit(runId, "browser.ready", {
        provider: "vercel",
        browserSessionId: "vercel-browser",
      });
    })();

    try {
      await entry.browserProvisioning;
    } finally {
      entry.browserProvisioning = undefined;
    }
  }


  private isUpstreamEnabled(entry: RunEntry): boolean {
    return isUpstreamEnabledFor(entry.identity.userEmail) || isUpstreamEnabledFor(entry.identity.userId);
  }

  private async ensureUpstreamBrowser(runId: string, entry: RunEntry): Promise<UpstreamAgentBrowserProvider> {
    if (entry.upstreamBrowser && entry.upstreamBrowserReady) {
      return entry.upstreamBrowser;
    }
    if (entry.upstreamBrowserProvisioning) {
      await entry.upstreamBrowserProvisioning;
      if (entry.upstreamBrowser) return entry.upstreamBrowser;
    }

    entry.upstreamBrowserProvisioning = (async () => {
      const rawSandbox = this.provider.getSandbox(runId);
      const session = createSandboxSessionLike(rawSandbox, (cmd) => this.command(runId, cmd));
      const provider = new UpstreamAgentBrowserProvider(session);
      const res = await provider.startSession({
        runId,
        tenantId: entry.identity.tenantId,
        projectId: entry.identity.projectId,
        surface: "vercel_cloud",
      });
      if (!res.ok) {
        throw new Error(res.error || "Failed to start upstream agent-browser session");
      }
      entry.upstreamBrowser = provider;
      entry.upstreamBrowserSessionId = res.sessionId;
      entry.upstreamBrowserReady = true;
      entry.store.emit(runId, "browser.ready", {
        provider: "agent-browser-upstream",
        browserSessionId: res.sessionId,
      });
    })();

    try {
      await entry.upstreamBrowserProvisioning;
    } finally {
      entry.upstreamBrowserProvisioning = undefined;
    }

    return entry.upstreamBrowser!;
  }

  private async upstreamBrowserTool(
    runId: string,
    entry: RunEntry,
    request: ToolRequest
  ): Promise<{ ok: boolean; output?: string; error?: string; exitCode: number; meta?: any }> {
    let browser: UpstreamAgentBrowserProvider;
    try {
      browser = await this.ensureUpstreamBrowser(runId, entry);
    } catch (err: any) {
      console.warn("[upstream-browser] Upstream initialization failed, falling back to Playwright:", err?.message || err);
      return this.browserTool(runId, entry, request);
    }

    const sessionId = entry.upstreamBrowserSessionId || buildSessionName(entry.identity.tenantId, runId);
    const tool = request.tool;
    const a = (request.arguments || {}) as Record<string, any>;

    switch (tool) {
      case "browser_open":
      case "browser_navigate": {
        const url = String(a.url || "").trim();
        const timeoutMs = typeof a.timeoutMs === "number" ? a.timeoutMs : 30000;
        const nav = await browser.navigate(url, timeoutMs);
        if (!nav.ok) {
          return {
            ok: false,
            error: nav.error || `Navigation to ${url} failed`,
            exitCode: 1,
            meta: { browserSessionId: sessionId, url: nav.url, error: nav.error },
          };
        }
        const snap = await browser.snapshot(true);
        const parts = [
          `Now at ${nav.url} — Title: ${nav.title || "(no title)"}`,
        ];
        if (nav.metaDesc) parts.push(`Description: ${nav.metaDesc}`);
        if (snap.interactiveElements.length > 0) {
          parts.push(`Interactive Elements (${snap.interactiveElements.length} found):`);
          const items = snap.interactiveElements.slice(0, 30).map(
            (e) => `[${e.ref}] ${e.role} "${e.name}"${e.href ? " -> " + e.href : ""}`
          );
          parts.push(items.join("\n"));
        } else if (snap.accessibilityTree) {
          parts.push(snap.accessibilityTree);
        }
        parts.push('Tip: Target elements using refs in browser_click or browser_fill (e.g. target: "@e1").');

        return {
          ok: true,
          output: parts.join("\n\n"),
          exitCode: 0,
          meta: {
            browserSessionId: sessionId,
            url: nav.url,
            title: nav.title,
            status: nav.status,
            interactiveElements: snap.interactiveElements,
            consoleErrors: snap.consoleErrors,
            networkErrors: snap.networkErrors,
            tree: snap.accessibilityTree,
          },
        };
      }

      case "browser_snapshot": {
        const interactiveOnly = a.interactiveOnly !== false;
        const snap = await browser.snapshot(interactiveOnly);
        const elements = snap.interactiveElements;
        const output = [
          `Page: ${snap.url} — Title: "${snap.title}"`,
          `Interactive Elements (${elements.length} found):`,
          elements.length > 0
            ? elements.map((e) => `[${e.ref}] ${e.role} "${e.name}"${e.href ? " -> " + e.href : ""}`).join("\n")
            : "(No interactive elements detected on this page)",
          'Tip: Target elements using refs in browser_click or browser_fill (e.g. target: "@e1").',
        ].join("\n\n");

        return {
          ok: true,
          output,
          exitCode: 0,
          meta: {
            browserSessionId: sessionId,
            url: snap.url,
            title: snap.title,
            interactiveCount: elements.length,
            interactiveElements: elements,
            consoleErrors: snap.consoleErrors,
            networkErrors: snap.networkErrors,
            tree: snap.accessibilityTree,
          },
        };
      }

      case "browser_screenshot":
      case "browser_evidence": {
        const fullPage = a.fullPage === true;
        const shot = await browser.screenshot(fullPage);
        if (!shot.ok) {
          return {
            ok: false,
            error: shot.error || "Failed to capture browser screenshot",
            exitCode: 1,
            meta: { browserSessionId: sessionId },
          };
        }
        return {
          ok: true,
          output: `Screenshot ${shot.screenshotId} taken.`,
          exitCode: 0,
          meta: {
            browserSessionId: sessionId,
            screenshot: { b64: shot.b64, mediaType: shot.mediaType },
            browserScreenshot: {
              screenshotId: shot.screenshotId,
              sessionId,
              width: shot.width,
              height: shot.height,
              sha256: shot.sha256,
            },
          },
        };
      }

      case "browser_click": {
        const target = a.target ?? a.ref ?? a.selector ?? (a.x !== undefined && a.y !== undefined ? { x: Number(a.x), y: Number(a.y) } : "");
        const res = await browser.click(target);
        return {
          ok: res.ok,
          output: res.output || (res.ok ? `Clicked ${typeof target === "string" ? target : JSON.stringify(target)}.` : undefined),
          error: res.error,
          exitCode: res.ok ? 0 : 1,
          meta: { browserSessionId: sessionId, url: res.currentUrl },
        };
      }

      case "browser_fill":
      case "browser_type":
      case "browser_input": {
        const target = a.target ?? a.ref ?? a.selector ?? "";
        const val = String(a.value ?? a.text ?? "");
        const res = await browser.fill(target, val);
        return {
          ok: res.ok,
          output: res.output || (res.ok ? `Filled ${typeof target === "string" ? target : JSON.stringify(target)} with "${val}".` : undefined),
          error: res.error,
          exitCode: res.ok ? 0 : 1,
          meta: { browserSessionId: sessionId, url: res.currentUrl },
        };
      }

      case "browser_scroll": {
        const deltaY = typeof a.deltaY === "number" ? a.deltaY : 400;
        const deltaX = typeof a.deltaX === "number" ? a.deltaX : 0;
        const res = await browser.scroll({ deltaY, deltaX });
        return {
          ok: res.ok,
          output: res.output || `Scrolled by ${deltaY}px.`,
          error: res.error,
          exitCode: res.ok ? 0 : 1,
          meta: { browserSessionId: sessionId },
        };
      }

      case "browser_console_errors": {
        const snap = await browser.snapshot();
        return {
          ok: true,
          output: snap.consoleErrors.join("\n") || "No console errors detected.",
          exitCode: 0,
          meta: { browserSessionId: sessionId, consoleErrors: snap.consoleErrors },
        };
      }

      case "browser_network_errors": {
        const snap = await browser.snapshot();
        const formatted = snap.networkErrors.map((e) => `${e.method} ${e.url} [${e.status}] ${e.error ?? ""}`.trim());
        return {
          ok: true,
          output: formatted.join("\n") || "No network errors detected.",
          exitCode: 0,
          meta: { browserSessionId: sessionId, networkErrors: snap.networkErrors },
        };
      }

      case "browser_tabs": {
        const tabs = await browser.getTabs();
        return {
          ok: true,
          output: tabs.map((t) => `Tab [${t.index}] ${t.active ? "(active) " : ""}${t.title} — ${t.url}`).join("\n"),
          exitCode: 0,
          meta: { browserSessionId: sessionId, tabs },
        };
      }

      case "browser_switch_tab": {
        const idx = typeof a.index === "number" ? a.index : 0;
        const res = await browser.switchTab(idx);
        return {
          ok: res.ok,
          output: res.output || `Switched to tab ${idx}.`,
          error: res.error,
          exitCode: res.ok ? 0 : 1,
          meta: { browserSessionId: sessionId },
        };
      }

      case "browser_set_viewport": {
        return {
          ok: true,
          output: "Viewport configured.",
          exitCode: 0,
          meta: { browserSessionId: sessionId },
        };
      }

      default:
        return this.browserTool(runId, entry, request);
    }
  }

  private async browserTool(
    runId: string,
    entry: RunEntry,
    request: ToolRequest
  ) {
    await this.ensureBrowser(runId, entry);

    const op = request.tool
      .replace(/^browser_/, "")
      .replace("set_viewport", "viewport")
      .replace("console_errors", "errors");
    const payload = Buffer.from(
      JSON.stringify({ op, args: request.arguments }),
      "utf8"
    ).toString("base64");

    const command =
      "printf %s " +
      shellQuote(payload) +
      " | base64 -d | curl -fsS " +
      "-H 'content-type: application/json' --data-binary @- " +
      "http://127.0.0.1:" +
      VERCEL_BROWSER_PORT +
      "/";

    const r = await this.command(runId, command, "", 45);
    if (!r.ok) {
      return {
        ok: false,
        error: r.output || "ORVYN Cloud browser request failed",
        exitCode: r.exitCode ?? 1,
      };
    }

    let parsed: any;
    try {
      parsed = JSON.parse(r.output);
    } catch {
      return {
        ok: false,
        error: "ORVYN Cloud browser returned an invalid response",
        exitCode: 1,
      };
    }

    return {
      ok: parsed.ok === true,
      output: parsed.output,
      error: parsed.error,
      exitCode: parsed.ok === true ? 0 : 1,
      meta: parsed.meta,
    };
  }

  private async ensureMcp(runId: string, entry: RunEntry): Promise<void> {
    if (entry.mcpReady) return;
    if (entry.mcpProvisioning) return entry.mcpProvisioning;

    entry.mcpProvisioning = (async () => {
      const root = "/tmp/orvyn-mcp";
      const scriptPath = root + "/server.mjs";
      const encoded = Buffer.from(
        VERCEL_MCP_SERVER_SOURCE,
        "utf8"
      ).toString("base64");

      const prepare = [
        "mkdir -p " + shellQuote(root),
        "printf %s " + shellQuote(encoded) + " | base64 -d > " + shellQuote(scriptPath),
        "test -f " + shellQuote(WORKSPACE + "/.orvyn/mcp.json"),
      ].join(" && ");

      const prepared = await this.command(runId, prepare, "", 30);
      if (!prepared.ok) {
        throw new Error(
          "No sandbox MCP configuration is available for this workspace."
        );
      }

      const launch = await this.command(
        runId,
        "nohup node " +
          shellQuote(scriptPath) +
          " >/tmp/orvyn-mcp.log 2>&1 </dev/null & echo $!"
      );
      if (!launch.ok) {
        throw new Error("Could not start ORVYN Cloud MCP runtime: " + launch.output);
      }

      const wait = await this.command(
        runId,
        "for i in $(seq 1 40); do " +
          "curl -fsS http://127.0.0.1:" +
          VERCEL_MCP_PORT +
          "/health >/dev/null && exit 0; sleep 1; done; " +
          "tail -n 120 /tmp/orvyn-mcp.log 2>/dev/null; exit 1",
        "",
        60
      );
      if (!wait.ok) {
        throw new Error(
          "ORVYN Cloud MCP runtime did not become ready: " +
            wait.output.slice(0, 2000)
        );
      }

      entry.mcpReady = true;
      entry.store.emit(runId, "mcp.ready", { provider: "vercel" });
    })();

    try {
      await entry.mcpProvisioning;
    } finally {
      entry.mcpProvisioning = undefined;
    }
  }

  private async mcpTool(
    runId: string,
    entry: RunEntry,
    request: ToolRequest
  ) {
    await this.ensureMcp(runId, entry);
    const payload = Buffer.from(
      JSON.stringify({
        op: request.tool === "mcp_list" ? "list" : "call",
        args: request.arguments,
      }),
      "utf8"
    ).toString("base64");

    const command =
      "printf %s " +
      shellQuote(payload) +
      " | base64 -d | curl -fsS " +
      "-H 'content-type: application/json' --data-binary @- " +
      "http://127.0.0.1:" +
      VERCEL_MCP_PORT +
      "/";

    const r = await this.command(runId, command, "", 45);
    if (!r.ok) {
      return {
        ok: false,
        error: r.output || "ORVYN Cloud MCP request failed",
        exitCode: r.exitCode ?? 1,
      };
    }

    try {
      const parsed = JSON.parse(r.output);
      return {
        ok: parsed.ok === true,
        output: parsed.output,
        error: parsed.error,
        exitCode: parsed.ok === true ? 0 : 1,
      };
    } catch {
      return {
        ok: false,
        error: "ORVYN Cloud MCP runtime returned an invalid response",
        exitCode: 1,
      };
    }
  }

  private async execute(request: ToolRequest, entry: RunEntry): Promise<ToolResponse> {
    const started = Date.now();
    const runId = request.runId;
    const args = { ...request.arguments };
    delete (args as any).__orvynGuard;

    let result: any;
    switch (request.tool) {
      case "read_file":
        result = await this.readFile(runId, args.path, args.encoding === "base64");
        break;
      case "write_file":
      case "create_file":
      case "apply_patch":
        result = await this.writeFile(
          runId,
          args.path,
          String(args.content ?? args.patch ?? ""),
          args.append === true
        );
        break;
      case "edit_file":
        result = await this.editFile(
          runId,
          args.path,
          String(args.old_string ?? ""),
          String(args.new_string ?? ""),
          args.replace_all === true
        );
        break;
      case "delete_file": {
        const target = absoluteWorkspacePath(args.path);
        if (!target || target === WORKSPACE) {
          result = { ok: false, error: "path must name a file inside the workspace", exitCode: 1 };
          break;
        }
        const r = await this.command(runId, "test ! -d " + shellQuote(target) + " && rm -f -- " + shellQuote(target));
        result = r.ok
          ? { ok: true, output: "Deleted " + String(args.path), exitCode: 0 }
          : { ok: false, error: r.output || "delete failed", exitCode: r.exitCode };
        break;
      }
      case "list_directory": {
        const target = absoluteWorkspacePath(args.path ?? "");
        if (!target) {
          result = { ok: false, error: "path escapes the workspace", exitCode: 1 };
          break;
        }
        const r = await this.command(runId, "ls -la -- " + shellQuote(target));
        result = r.ok
          ? { ok: true, output: r.output, exitCode: r.exitCode }
          : { ok: false, error: r.output, exitCode: r.exitCode };
        break;
      }
      case "search_code":
      case "search_files": {
        const q = String(args.query ?? args.pattern ?? "");
        if (!q) {
          result = { ok: false, error: "query is required", exitCode: 1 };
          break;
        }
        const r = await this.command(
          runId,
          "grep -rn --binary-files=without-match -- " +
            shellQuote(q) +
            " " +
            shellQuote(WORKSPACE) +
            " 2>/dev/null | head -100"
        );
        result = { ok: true, output: r.output || "(no matches)", exitCode: 0 };
        break;
      }
      case "terminal":
      case "run_command": {
        const command = String(args.command ?? "").trim();
        entry.store.emit(runId, "terminal.started", { command, provider: "vercel" });
        const r = await this.command(
          runId,
          command,
          safeRel(args.cwd) ?? undefined,
          Math.max(1, Math.ceil(request.timeoutMs / 1000))
        );
        entry.store.emit(runId, "terminal.output", { data: r.output.slice(0, 4000), provider: "vercel" });
        entry.store.emit(runId, "terminal.completed", { exitOk: r.ok, exitCode: r.exitCode ?? -1, provider: "vercel" });
        result = r.ok
          ? { ok: true, output: r.output, exitCode: r.exitCode }
          : { ok: false, error: r.output, output: r.output, exitCode: r.exitCode };
        break;
      }
      case "run_tests": {
        const r = await this.command(runId, "npm test", "", Math.max(60, Math.ceil(request.timeoutMs / 1000)));
        result = r.ok
          ? { ok: true, output: r.output, exitCode: r.exitCode }
          : { ok: false, error: r.output, output: r.output, exitCode: r.exitCode };
        break;
      }
      case "run_typecheck": {
        const r = await this.command(runId, "npx --no-install tsc --noEmit", "", Math.max(60, Math.ceil(request.timeoutMs / 1000)));
        result = r.ok
          ? { ok: true, output: r.output, exitCode: r.exitCode }
          : { ok: false, error: r.output, output: r.output, exitCode: r.exitCode };
        break;
      }
      case "run_linter": { const r = await this.command(runId, "npm run lint --if-present", "", Math.max(60, Math.ceil(request.timeoutMs / 1000))); result = r.ok ? { ok: true, output: r.output, exitCode: r.exitCode } : { ok: false, error: r.output, output: r.output, exitCode: r.exitCode }; break; }
      case "git_status": {
        const r = await this.command(runId, "git status --porcelain=v1 -b");
        result = { ok: r.ok, output: r.output, error: r.ok ? undefined : r.output, exitCode: r.exitCode };
        break;
      }
      case "git_diff": {
        const r = await this.command(runId, "git diff");
        result = { ok: r.ok, output: r.output || "(no diff)", error: r.ok ? undefined : r.output, exitCode: r.exitCode };
        break;
      }
      case "git_log": {
        const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 200);
        const r = await this.command(runId, "git log --oneline --decorate -n " + limit);
        result = { ok: r.ok, output: r.output, error: r.ok ? undefined : r.output, exitCode: r.exitCode };
        break;
      }
      case "git_branch": {
        const r = await this.command(runId, "git branch -a --no-color");
        result = { ok: r.ok, output: r.output, error: r.ok ? undefined : r.output, exitCode: r.exitCode };
        break;
      }
      case "git_checkout": {
        const branch = String(args.branch ?? "");
        if (!/^[A-Za-z0-9._\/-]{1,200}$/.test(branch) || branch.startsWith("-")) {
          result = { ok: false, error: "invalid branch name", exitCode: 1 };
          break;
        }
        const r = await this.command(runId, "git checkout " + (args.create === true ? "-b " : "") + shellQuote(branch));
        result = { ok: r.ok, output: r.output, error: r.ok ? undefined : r.output, exitCode: r.exitCode };
        break;
      }
      case "git_commit": {
        const message = String(args.message ?? "").trim();
        if (!message) {
          result = { ok: false, error: "commit message is required", exitCode: 1 };
          break;
        }
        const r = await this.command(runId, "git add -A && git commit -m " + shellQuote(message));
        result = { ok: r.ok, output: r.output, error: r.ok ? undefined : r.output, exitCode: r.exitCode };
        break;
      }
      case "start_process":
        result = await this.startProcess(runId, entry, args);
        break;
      case "stop_process":
      case "read_process_logs":
        result = await this.processTool(runId, entry, request);
        break;
      case "list_processes":
        result = {
          ok: true,
          output: jsonOrText(
            [...entry.processes.values()].map((p) => ({
              id: p.id,
              command: p.command,
              cwd: p.cwd,
              pid: p.pid,
              startedAt: p.startedAt,
              status: "running",
            }))
          ),
          exitCode: 0,
        };
        break;
      case "browser_open":
      case "browser_navigate":
      case "browser_set_viewport":
      case "browser_click":
      case "browser_type":
      case "browser_scroll":
      case "browser_console_errors":
      case "browser_screenshot":
      case "browser_evidence":
      case "browser_input":
      case "browser_snapshot":
      case "browser_fill":
      case "browser_tabs":
      case "browser_switch_tab":
      case "browser_network_errors":
        if (this.isUpstreamEnabled(entry)) {
          result = await this.upstreamBrowserTool(runId, entry, request);
        } else {
          result = await this.browserTool(runId, entry, request);
        }
        break;
      case "mcp_list":
      case "mcp_call":
        result = await this.mcpTool(runId, entry, request);
        break;
      default:
        result = {
          ok: false,
          error: "Unsupported Vercel cloud tool: " + request.tool,
          exitCode: 1,
        };
    }

    return response(request, started, result);
  }
}

export const vercelToolRunner = new VercelToolRunner();
