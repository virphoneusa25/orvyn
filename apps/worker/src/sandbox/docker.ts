// apps/worker/src/sandbox/docker.ts
//
// The existing mission container, behind the provider interface. Same
// hardening as before (no network, all capabilities dropped,
// no-new-privileges, pids/CPU/memory limits); limits now come from the plan
// tier the control plane chose. Adds what the old inline code lacked: real
// exit codes, a per-command timeout enforced inside the container, and a
// deterministic name so a restarted worker can find its sandbox again.

import { spawn } from "child_process";
import { docker, labelValue } from "./dockerCli";
import {
  SandboxError,
  type AttachSession,
  type CreateSandboxSpec,
  type ExecOptions,
  type ExecResult,
  type ExecutionSandboxProvider,
  type ProviderHealth,
  type RuntimeCapabilities,
  type SandboxHandle,
  type SandboxIdentity,
  type SandboxState,
} from "./types";

export const DOCKER_SANDBOX_IMAGE = process.env.ORVYN_SANDBOX_IMAGE || "node:20-slim";
const OUTPUT_CAP = 2_000_000;

export function dockerSandboxName(sandboxId: string): string {
  return `orvyn-sbx-${sandboxId.replace(/^sbx_/, "").replace(/[^a-zA-Z0-9]/g, "").slice(0, 24)}`;
}

function stateFromDocker(status: string): SandboxState {
  switch (status) {
    case "created": return "provisioning";
    case "running": return "ready";
    case "paused": return "degraded";
    case "restarting": return "recovering";
    case "removing": return "stopping";
    case "exited": case "dead": return "stopped";
    default: return "degraded";
  }
}

function shq(s: string): string { return "'" + s.replace(/'/g, "'\\''") + "'"; }

export class DockerExecutionProvider implements ExecutionSandboxProvider {
  readonly id = "docker" as const;
  constructor(private readonly image = DOCKER_SANDBOX_IMAGE) {}

  getCapabilities(): RuntimeCapabilities {
    return {
      filesystem: true, terminal: true, attach: true,
      network: "none", networkPolicyTemplates: ["code-basic"], liveNetworkPolicyUpdate: false,
      credentialBroker: false, reconnect: true, retainedSandboxes: true, browser: false, gpu: false,
    };
  }

  async getHealth(): Promise<ProviderHealth> {
    const t = Date.now();
    const r = await docker(["version", "--format", "{{.Server.Version}}"], { timeoutMs: 10_000 });
    return { provider: "docker", healthy: r.code === 0, version: r.code === 0 ? r.stdout : undefined, detail: r.code === 0 ? "daemon reachable" : "daemon unreachable", latencyMs: Date.now() - t, checkedAt: Date.now() };
  }

  async createSandbox(spec: CreateSandboxSpec): Promise<SandboxHandle> {
    // Docker has no per-host egress control, so every template runs with no
    // network at all (fail closed). The handle reports code-basic truthfully.
    const started = Date.now();
    const name = dockerSandboxName(spec.sandboxId);
    const r = spec.resources;
    const id = spec.identity;
    await docker(["rm", "-f", name]); // re-run safety: a stale sandbox with this id is replaced
    const create = await docker([
      "create", "--name", name,
      "--network", "none",
      "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges",
      "--memory", `${r.memoryMb}m`, "--memory-swap", `${r.memoryMb}m`,
      "--cpus", String(r.cpus), "--pids-limit", String(r.pidsLimit),
      "--label", "orvyn.sandbox=1",
      "--label", `orvyn.sandbox_id=${labelValue(spec.sandboxId)}`,
      "--label", `orvyn.tenant_id=${labelValue(id.tenantId)}`,
      "--label", `orvyn.organization_id=${labelValue(id.organizationId)}`,
      "--label", `orvyn.project_id=${labelValue(id.projectId)}`,
      "--label", `orvyn.workspace_id=${labelValue(id.workspaceId)}`,
      "--label", `orvyn.run_id=${labelValue(id.runId)}`,
      "--label", `orvyn.retention=${spec.retention}`,
      "--label", `orvyn.created_at=${started}`,
      "--label", `orvyn.expires_at=${started + r.maxLifetimeS * 1000}`,
      "-v", `${spec.workspaceHostPath}:/workspace`,
      "-w", "/workspace",
      ...Object.entries(spec.env ?? {}).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
      spec.image || this.image,
      "sleep", String(r.maxLifetimeS),
    ]);
    if (create.code !== 0) throw new SandboxError("sandbox_unavailable", `Container create failed: ${create.stderr.slice(0, 300)}`);
    const start = await docker(["start", create.stdout]);
    if (start.code !== 0) {
      await docker(["rm", "-f", create.stdout]);
      throw new SandboxError("sandbox_unavailable", `Container start failed: ${start.stderr.slice(0, 300)}`);
    }
    return {
      sandboxId: spec.sandboxId, provider: "docker", providerSandboxId: create.stdout, name,
      identity: spec.identity, state: "ready", createdAt: started, policyTemplate: "code-basic", policyVersion: 1,
      retention: spec.retention, provisionMs: Date.now() - started,
    };
  }

  async getSandbox(sandboxId: string, identity: SandboxIdentity): Promise<SandboxHandle | null> {
    const name = dockerSandboxName(sandboxId);
    const r = await docker(["inspect", "--format", "{{.Id}}|{{.State.Status}}|{{index .Config.Labels \"orvyn.organization_id\"}}|{{index .Config.Labels \"orvyn.created_at\"}}|{{index .Config.Labels \"orvyn.retention\"}}", name]);
    if (r.code !== 0) return null;
    const [cid, status, org, created, retention] = r.stdout.split("|");
    // A sandbox is only ever handed back to the organization that created it.
    if (org !== labelValue(identity.organizationId)) return null;
    return {
      sandboxId, provider: "docker", providerSandboxId: cid!, name, identity,
      state: stateFromDocker(status!), createdAt: Number(created) || 0, policyTemplate: "code-basic", policyVersion: 1,
      retention: retention === "retained" ? "retained" : "ephemeral",
    };
  }

  async exec(handle: SandboxHandle, command: string, opts: ExecOptions = {}): Promise<ExecResult> {
    if (!command.trim()) throw new SandboxError("tool_bad_args", "Empty command.", false);
    const startedAt = Date.now();
    const timeoutS = Math.max(1, Math.floor(opts.timeoutS ?? 120));
    const args = ["exec", "-i", "-w", opts.cwd || "/workspace"];
    for (const [k, v] of Object.entries(opts.env ?? {})) args.push("-e", `${k}=${v}`);
    // `timeout` inside the container kills the whole command tree; the host
    // guard covers a wedged docker exec.
    args.push(handle.providerSandboxId || handle.name, "sh", "-c", `exec timeout -k 5 ${timeoutS} sh -c ${shq(command)}`);
    return new Promise((resolve, reject) => {
      const p = spawn("docker", args, { windowsHide: true });
      let stdout = "";
      let stderr = "";
      let hostKilled = false;
      const guard = setTimeout(() => { hostKilled = true; try { p.kill("SIGKILL"); } catch { /* gone */ } }, (timeoutS + 15) * 1000);
      const onAbort = () => { try { p.kill("SIGKILL"); } catch { /* gone */ } };
      opts.signal?.addEventListener("abort", onAbort, { once: true });
      p.stdout.on("data", (d: Buffer) => { const s = d.toString("utf8"); if (stdout.length < OUTPUT_CAP) stdout += s; opts.onOutput?.(s, "stdout"); });
      p.stderr.on("data", (d: Buffer) => { const s = d.toString("utf8"); if (stderr.length < OUTPUT_CAP) stderr += s; opts.onOutput?.(s, "stderr"); });
      p.on("error", (e) => { clearTimeout(guard); reject(new SandboxError("sandbox_unavailable", `docker exec failed: ${e.message}`)); });
      p.on("close", (code, signal) => {
        clearTimeout(guard);
        opts.signal?.removeEventListener("abort", onAbort);
        const exitCode = code ?? (signal ? 128 + 9 : -1);
        if (exitCode === 125 || (exitCode !== 0 && !stdout && /No such container|is not running/i.test(stderr))) {
          reject(new SandboxError("sandbox_unavailable", `Sandbox is not running: ${stderr.slice(0, 200)}`));
          return;
        }
        resolve({
          exitCode, stdout, stderr, startedAt, completedAt: Date.now(),
          timedOut: exitCode === 124 || (exitCode === 137 && Date.now() - startedAt >= timeoutS * 1000) || hostKilled,
          ...(signal ? { signal } : {}),
        });
      });
      if (opts.stdin !== undefined) p.stdin.end(opts.stdin); else p.stdin.end();
    });
  }

  async attach(handle: SandboxHandle): Promise<AttachSession> {
    const p = spawn("docker", ["exec", "-i", "-w", "/workspace", handle.providerSandboxId || handle.name, "sh"], { windowsHide: true });
    const listeners: Array<(c: string) => void> = [];
    const emit = (d: Buffer) => { const s = d.toString("utf8"); for (const l of listeners) l(s); };
    p.stdout.on("data", emit);
    p.stderr.on("data", emit);
    const exited = new Promise<number>((resolve) => p.on("close", (code) => resolve(code ?? -1)));
    return {
      write: (data) => { p.stdin.write(data); },
      onData: (cb) => { listeners.push(cb); },
      close: async () => { try { p.stdin.end(); p.kill("SIGTERM"); } catch { /* gone */ } await exited; },
      exited,
    };
  }

  async stop(handle: SandboxHandle): Promise<void> {
    await docker(["stop", "-t", "5", handle.providerSandboxId || handle.name]);
  }

  async destroy(handle: SandboxHandle): Promise<void> {
    const r = await docker(["rm", "-f", handle.providerSandboxId || handle.name]);
    if (r.code !== 0 && !/No such container/i.test(r.stderr)) {
      throw new SandboxError("sandbox_unavailable", `Container remove failed: ${r.stderr.slice(0, 200)}`);
    }
  }

  async list() {
    const r = await docker(["ps", "-a", "--filter", "label=orvyn.sandbox=1", "--format", "{{.ID}}|{{.Names}}|{{.State}}|{{.Labels}}"]);
    if (r.code !== 0 || !r.stdout) return [];
    return r.stdout.split("\n").map((line) => {
      const [id, name, state, labelStr] = line.split("|");
      const labels: Record<string, string> = {};
      for (const kv of (labelStr ?? "").split(",")) { const i = kv.indexOf("="); if (i > 0) labels[kv.slice(0, i)] = kv.slice(i + 1); }
      return { sandboxId: labels["orvyn.sandbox_id"] ?? "", name: name!, providerSandboxId: id!, state: stateFromDocker(state!), createdAt: Number(labels["orvyn.created_at"]) || 0, labels };
    });
  }
}
