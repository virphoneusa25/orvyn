// apps/worker/src/sandbox/openshell.ts
//
// NVIDIA OpenShell as an execution sandbox underneath ORVYN. OpenShell only
// runs commands: ORVYN keeps the model loop, tools, tenancy, billing and
// verification. The gateway is a private service; only this worker (and
// admin diagnostics through it) talks to it, over mTLS.
//
// Pinned: gateway/supervisor/sandbox 0.1.2 and the matching TypeScript SDK
// (vendored at apps/worker/vendor, built from the v0.1.2 tag). The SDK is ESM,
// so it is loaded with a real dynamic import at first use; a worker without
// it still runs Docker sandboxes.
//
// Isolation layers per sandbox:
//   - one OpenShell workspace per ORVYN organization (orvyn-<org hash>):
//     the gateway refuses cross-workspace access to sandboxes and providers
//   - the workspace mount is a Docker volume labeled for exactly that
//     OpenShell workspace, so resource admission refuses it anywhere else
//   - deny-by-default network policy rendered from a reviewed template
//   - plan-tier CPU/memory limits; pids limit, cap-drop ALL,
//     no-new-privileges and a non-root user are enforced by the driver

import * as crypto from "crypto";
import * as fs from "fs";
import { docker, labelValue } from "./dockerCli";
import { renderPolicy } from "./policies";
import {
  SandboxError,
  type AttachSession,
  type CreateSandboxSpec,
  type CredentialGrant,
  type ExecOptions,
  type ExecResult,
  type ExecutionSandboxProvider,
  type PolicyTemplateId,
  type ProviderHealth,
  type RuntimeCapabilities,
  type SandboxHandle,
  type SandboxIdentity,
  type SandboxState,
} from "./types";

export const OPENSHELL_VERSION = "0.1.2";

export interface OpenShellConfig {
  gateway: string;
  caCertFile?: string;
  clientCertFile?: string;
  clientKeyFile?: string;
  image: string;
  readyTimeoutS: number;
  /** Fetches a brokered credential from the control plane (never logged). */
  credentialSource?: (runId: string, integrationId: string) => Promise<Record<string, string> | null>;
}

export function openShellConfigFromEnv(env: NodeJS.ProcessEnv = process.env): OpenShellConfig | null {
  const gateway = env.OPENSHELL_GATEWAY_URL?.trim();
  if (!gateway) return null;
  return {
    gateway,
    caCertFile: env.OPENSHELL_TLS_CA || undefined,
    clientCertFile: env.OPENSHELL_TLS_CERT || undefined,
    clientKeyFile: env.OPENSHELL_TLS_KEY || undefined,
    image: env.OPENSHELL_SANDBOX_IMAGE || "orvyn/sandbox:0.1.2-1",
    readyTimeoutS: Number(env.OPENSHELL_READY_TIMEOUT_S) || 120,
  };
}

// A real dynamic import survives CommonJS compilation this way.
const importEsm = new Function("s", "return import(s)") as (s: string) => Promise<any>;

/** DNS-1123 label (the gateway allows 19 chars), deterministic per organization. Never reveals the org id. */
export function openShellWorkspaceFor(organizationId: string): string {
  return `orv-${crypto.createHash("sha256").update(`org:${organizationId}`).digest("hex").slice(0, 15)}`;
}

/** The gateway allows 19-char names: "s-" + 17 hex of the ORVYN id (the id itself rides in a label). */
export function openShellSandboxName(sandboxId: string): string {
  return `s-${crypto.createHash("sha256").update(sandboxId).digest("hex").slice(0, 17)}`;
}

function workspaceVolumeName(sandboxId: string): string {
  return `orvyn-ws-${sandboxId.replace(/^sbx_/, "").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 40)}`;
}

/** Kubernetes-style label value: <=63 chars of [A-Za-z0-9._-], alnum at both ends. */
function k8sLabel(v: string | null | undefined): string {
  const s = String(v ?? "").replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 63).replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, "");
  return s;
}

export function stateFromPhase(phase: string): SandboxState {
  switch (phase) {
    case "provisioning": case "starting": return "provisioning";
    case "ready": return "ready";
    case "error": return "failed";
    case "deleting": case "stopping": return "stopping";
    case "stopped": return "stopped";
    case "completed": return "completed";
    default: return "degraded";
  }
}

// OpenShell answers an unapproved destination with a synthetic 198.18.x.x DNS
// answer and a refused connect (EACCES / "Couldn't connect"), or with a 403
// JSON body for inspected HTTP. Nothing else in a sandbox fails that way.
const DENIAL_RE = /policy_denied|X-OpenShell-Policy|CONNECT tunnel failed, response 403|Received HTTP code 403 from proxy|blocked by (the )?(sandbox|network) policy|connect EACCES|\bconnect: Permission denied|EACCES 198\.18\.|Failed to connect to \S+ port \d+ after \d+ ms: Couldn't connect to server|\[Errno 13\][^\n]*(connect|Permission denied)|198\.18\.\d+\.\d+/i;
const CREDENTIAL_DENIAL_RE = /credential[_ ](binding|policy)[_ ]denied|provider credential not permitted/i;

/** Maps a finished command to a failure class when the sandbox, not the program, refused it. */
export function classifyExecOutput(r: { exitCode: number; stderr: string; stdout: string }): "network_policy_denied" | "credential_policy_denied" | null {
  if (r.exitCode === 0) return null;
  const text = `${r.stderr}\n${r.stdout.slice(-4000)}`;
  if (CREDENTIAL_DENIAL_RE.test(text)) return "credential_policy_denied";
  if (DENIAL_RE.test(text)) return "network_policy_denied";
  return null;
}

export class OpenShellExecutionProvider implements ExecutionSandboxProvider {
  readonly id = "openshell" as const;
  private client: any = null;
  private sdk: { raw: any; protobuf: any } | null = null;
  private workspaces = new Set<string>();
  private connecting: Promise<any> | null = null;

  constructor(private readonly config: OpenShellConfig) {}

  getCapabilities(): RuntimeCapabilities {
    return {
      filesystem: true, terminal: true, attach: true,
      network: "policy",
      networkPolicyTemplates: ["code-basic", "web-development", "research", "github", "deployment", "server-admin"],
      liveNetworkPolicyUpdate: true, credentialBroker: true, reconnect: true, retainedSandboxes: true,
      browser: false, gpu: false,
    };
  }

  private async connect(): Promise<any> {
    if (this.client) return this.client;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      let mod: any;
      try {
        mod = await importEsm("@nvidia/openshell-sdk");
        this.sdk = { raw: await importEsm("@nvidia/openshell-sdk/raw"), protobuf: await importEsm("@bufbuild/protobuf") };
      } catch (e: any) {
        throw new SandboxError("sandbox_unavailable", `OpenShell SDK not installed on this worker (${String(e?.code ?? e?.message ?? e).slice(0, 80)})`);
      }
      const read = (f?: string) => (f ? fs.readFileSync(f) : undefined);
      this.client = await mod.OpenShellClient.connect({
        gateway: this.config.gateway,
        caCert: read(this.config.caCertFile),
        clientCert: read(this.config.clientCertFile),
        clientKey: read(this.config.clientKeyFile),
      });
      return this.client;
    })();
    try { return await this.connecting; } finally { this.connecting = null; }
  }

  private wrap(e: any, what: string): SandboxError {
    if (e instanceof SandboxError) return e;
    const code = String(e?.code ?? "");
    const msg = String(e?.message ?? e).replace(/\s+/g, " ").slice(0, 300);
    // SdkError codes, or raw ConnectError numeric codes (3 invalid argument, 7 permission, 16 unauthenticated).
    if (code === "invalid_config" || code === "3" || code === "9") return new SandboxError("tool_internal", `${what}: ${msg}`, false);
    if (code === "auth" || code === "7" || code === "16") return new SandboxError("sandbox_unavailable", `${what}: gateway refused the worker's credentials`, false);
    return new SandboxError("sandbox_unavailable", `${what}: ${msg}`);
  }

  async getHealth(): Promise<ProviderHealth> {
    const t = Date.now();
    try {
      const c = await this.connect();
      const h = await c.health();
      const healthy = h.status === "healthy" || h.status === "HEALTHY" || h.status === "serving";
      return { provider: "openshell", healthy, version: h.version, detail: `gateway ${h.status}`, latencyMs: Date.now() - t, checkedAt: Date.now() };
    } catch (e: any) {
      return { provider: "openshell", healthy: false, detail: this.wrap(e, "health").message, latencyMs: Date.now() - t, checkedAt: Date.now() };
    }
  }

  private async ensureWorkspace(name: string, organizationId: string): Promise<void> {
    if (this.workspaces.has(name)) return;
    const c = await this.connect();
    try {
      await c.raw.createWorkspace({ name, labels: { "orvyn.ai/org": k8sLabel(crypto.createHash("sha256").update(organizationId).digest("hex").slice(0, 16)) } });
    } catch (e: any) {
      const code = e?.code ?? e?.rawMessage;
      // Connect code 6 = AlreadyExists.
      if (!(code === 6 || /already exists/i.test(String(e?.message)))) throw this.wrap(e, "workspace");
    }
    this.workspaces.add(name);
  }

  /** A Docker volume that is a bind of exactly this run's workspace, approved for exactly one OpenShell workspace. */
  private async ensureWorkspaceVolume(sandboxId: string, hostPath: string, osWorkspace: string): Promise<string> {
    const vol = workspaceVolumeName(sandboxId);
    const existing = await docker(["volume", "inspect", "--format", "{{index .Labels \"openshell.ai/sandbox-attachable-workspace\"}}|{{index .Options \"device\"}}", vol]);
    if (existing.code === 0) {
      const [ws, device] = existing.stdout.split("|");
      if (ws === osWorkspace && device === hostPath) return vol;
      throw new SandboxError("tool_internal", "Workspace volume exists with a different owner; refusing to reuse it.", false);
    }
    const r = await docker([
      "volume", "create", "--driver", "local",
      "--opt", "type=none", "--opt", "o=bind", "--opt", `device=${hostPath}`,
      "--label", "openshell.ai/sandbox-attachable=true",
      "--label", `openshell.ai/sandbox-attachable-workspace=${osWorkspace}`,
      "--label", "orvyn.sandbox=1",
      "--label", `orvyn.sandbox_id=${labelValue(sandboxId)}`,
      vol,
    ]);
    if (r.code !== 0) throw new SandboxError("sandbox_unavailable", `Workspace volume create failed: ${r.stderr.slice(0, 200)}`);
    return vol;
  }

  private policyMessage(policy: Record<string, any>): any {
    const { raw, protobuf } = this.sdk!;
    return protobuf.fromJson(raw.SandboxPolicySchema, policy);
  }

  private async ensureProviders(spec: Pick<CreateSandboxSpec, "credentials" | "identity">, osWorkspace: string): Promise<string[]> {
    const names: string[] = [];
    if (!spec.credentials?.length) return names;
    const c = await this.connect();
    for (const grant of spec.credentials) {
      if (grant.organizationId !== spec.identity.organizationId) {
        throw new SandboxError("credential_policy_denied", "Credential grant belongs to another organization.", false);
      }
      const creds = await this.config.credentialSource?.(spec.identity.runId ?? "", grant.integrationId);
      if (!creds) continue; // not connected: the sandbox simply has no credential
      const name = k8sLabel(`orvyn-${grant.integrationId}`).toLowerCase();
      const provider = { metadata: { name, workspace: osWorkspace, labels: { "orvyn.ai/integration": k8sLabel(grant.integrationId) } }, type: grant.type, credentials: creds, config: {} };
      const scope = { selection: { case: "workspace", value: osWorkspace } };
      try {
        await c.raw.createProvider({ workspaceScope: scope, provider });
      } catch (e: any) {
        if (!/already exists/i.test(String(e?.message))) throw new SandboxError("credential_policy_denied", `Credential provider setup failed: ${String(e?.rawMessage ?? "").slice(0, 120)}`, false);
        await c.raw.updateProvider({ workspaceScope: scope, provider }).catch(() => { /* keep the existing binding */ });
      }
      names.push(name);
    }
    return names;
  }

  async createSandbox(spec: CreateSandboxSpec): Promise<SandboxHandle> {
    const started = Date.now();
    const c = await this.connect();
    const id = spec.identity;
    const osWorkspace = openShellWorkspaceFor(id.organizationId);
    const name = openShellSandboxName(spec.sandboxId);
    try {
      await this.ensureWorkspace(osWorkspace, id.organizationId);
      const volume = await this.ensureWorkspaceVolume(spec.sandboxId, spec.workspaceHostPath, osWorkspace);
      const { version, policy } = renderPolicy(spec.policyTemplate);
      const providers = await this.ensureProviders(spec, osWorkspace);
      const labels: Record<string, string> = {
        "orvyn.ai/sandbox-id": k8sLabel(spec.sandboxId),
        "orvyn.ai/tenant": k8sLabel(id.tenantId),
        "orvyn.ai/project": k8sLabel(id.projectId ?? "none"),
        "orvyn.ai/workspace": k8sLabel(id.workspaceId),
        "orvyn.ai/run": k8sLabel(id.runId ?? ""),
        "orvyn.ai/retention": spec.retention,
        "orvyn.ai/policy": `${spec.policyTemplate}.v${version}`,
        "orvyn.ai/created-at": String(started),
        "orvyn.ai/expires-at": String(started + spec.resources.maxLifetimeS * 1000),
      };
      await c.sandbox.create({
        name,
        workspace: osWorkspace,
        labels,
        environment: { ...(spec.env ?? {}), ORVYN_WORKSPACE: "/workspace" },
        providers,
        policy: this.policyMessage(policy),
        // Keep the supervisor's main process alive for the sandbox's TTL.
        command: ["sleep", String(spec.resources.maxLifetimeS)],
        rawSpec: {
          template: {
            image: spec.image || this.config.image,
            labels: { "orvyn.sandbox": "1", "orvyn.sandbox_id": labelValue(spec.sandboxId) },
            resources: ({ limits: { cpu: String(spec.resources.cpus), memory: `${spec.resources.memoryMb}Mi` } }),
            driverConfig: ({ docker: { mounts: [{ type: "volume", source: volume, target: "/workspace", read_only: false }] } }),
          },
        },
      });
      const ref = await c.sandbox.waitReady(name, this.config.readyTimeoutS, { workspace: osWorkspace });
      return {
        sandboxId: spec.sandboxId, provider: "openshell", providerSandboxId: ref.id, name, identity: id,
        state: stateFromPhase(ref.phase), createdAt: started, policyTemplate: spec.policyTemplate, policyVersion: version,
        retention: spec.retention, scope: osWorkspace, provisionMs: Date.now() - started,
      };
    } catch (e: any) {
      // Nothing half-made survives a failed create (the volume is only a bind pointer).
      await c.sandbox.delete(name, { workspace: osWorkspace, allowMissing: true }).catch(() => {});
      await docker(["volume", "rm", "-f", workspaceVolumeName(spec.sandboxId)]).catch(() => {});
      throw this.wrap(e, "sandbox create");
    }
  }

  async getSandbox(sandboxId: string, identity: SandboxIdentity): Promise<SandboxHandle | null> {
    const c = await this.connect();
    const osWorkspace = openShellWorkspaceFor(identity.organizationId);
    const name = openShellSandboxName(sandboxId);
    try {
      const ref = await c.sandbox.get(name, { workspace: osWorkspace });
      if (ref.labels?.["orvyn.ai/sandbox-id"] !== k8sLabel(sandboxId)) return null;
      const [tpl, ver] = String(ref.labels["orvyn.ai/policy"] ?? "code-basic.v1").split(".v");
      return {
        sandboxId, provider: "openshell", providerSandboxId: ref.id, name, identity, scope: osWorkspace,
        state: stateFromPhase(ref.phase), createdAt: Number(ref.labels["orvyn.ai/created-at"]) || 0,
        policyTemplate: tpl as PolicyTemplateId, policyVersion: Number(ver) || 1,
        retention: ref.labels["orvyn.ai/retention"] === "retained" ? "retained" : "ephemeral",
      };
    } catch (e: any) {
      if (e?.code === "not_found") return null;
      throw this.wrap(e, "sandbox lookup");
    }
  }

  async exec(handle: SandboxHandle, command: string, opts: ExecOptions = {}): Promise<ExecResult> {
    if (!command.trim()) throw new SandboxError("tool_bad_args", "Empty command.", false);
    const c = await this.connect();
    const startedAt = Date.now();
    const timeoutS = Math.max(1, Math.floor(opts.timeoutS ?? 120));
    let stdout = "";
    let stderr = "";
    let exitCode: number | undefined;
    try {
      for await (const ev of c.sandbox.execStream(handle.name, ["sh", "-c", command], {
        workspace: handle.scope,
        workdir: opts.cwd || "/workspace",
        environment: opts.env ?? {},
        timeoutSecs: timeoutS,
        noLoginShell: true,
        ...(opts.stdin !== undefined ? { stdin: Buffer.from(opts.stdin) } : {}),
        ...(opts.signal ? { signal: opts.signal } : {}),
      })) {
        if ("type" in ev) { exitCode = ev.exitCode; continue; }
        const s = Buffer.from(ev.data).toString("utf8");
        if (ev.stream === "stdout") { if (stdout.length < 2_000_000) stdout += s; opts.onOutput?.(s, "stdout"); }
        else { if (stderr.length < 2_000_000) stderr += s; opts.onOutput?.(s, "stderr"); }
      }
    } catch (e: any) {
      if (e?.code === "not_found") throw new SandboxError("sandbox_unavailable", "Sandbox is gone.");
      throw this.wrap(e, "exec");
    }
    if (exitCode === undefined) throw new SandboxError("sandbox_unavailable", "Exec stream ended without an exit status.");
    const result: ExecResult = { exitCode, stdout, stderr, startedAt, completedAt: Date.now(), timedOut: exitCode === 124 };
    return result;
  }

  async attach(handle: SandboxHandle, opts: { cols?: number; rows?: number } = {}): Promise<AttachSession> {
    const c = await this.connect();
    const session = await c.sandbox.execInteractive(handle.name, ["sh"], {
      workspace: handle.scope, workdir: "/workspace", tty: true, cols: opts.cols ?? 120, rows: opts.rows ?? 32,
    });
    const listeners: Array<(s: string) => void> = [];
    void (async () => {
      try {
        for await (const ev of session.output) {
          if ("type" in ev) break;
          const s = Buffer.from(ev.data).toString("utf8");
          for (const l of listeners) l(s);
        }
      } catch { /* session ended */ }
    })();
    return {
      write: (d) => session.write(Buffer.from(d)),
      onData: (cb) => { listeners.push(cb); },
      resize: (cols, rows) => session.resize(cols, rows),
      close: async () => { try { session.close(); session.cancel?.(); } catch { /* gone */ } },
      exited: session.done.catch(() => -1),
    };
  }

  async stop(handle: SandboxHandle): Promise<void> {
    const c = await this.connect();
    try {
      await c.raw.stopSandbox({ name: handle.name, workspaceScope: { selection: { case: "workspace", value: handle.scope } } });
    } catch (e: any) {
      if (!/not.?found/i.test(String(e?.message))) throw this.wrap(e, "stop");
    }
  }

  async destroy(handle: SandboxHandle): Promise<void> {
    const c = await this.connect();
    try {
      const r = await c.sandbox.delete(handle.name, { workspace: handle.scope, allowMissing: true });
      if (r.outcome === "accepted") await c.sandbox.waitDeleted(handle.name, 60, { workspace: handle.scope, expectedSandboxId: r.sandboxId }).catch(() => {});
    } catch (e: any) {
      throw this.wrap(e, "destroy");
    }
    // The volume is only a bind; removing it never touches workspace bytes.
    await docker(["volume", "rm", "-f", workspaceVolumeName(handle.sandboxId)]);
  }

  async updateNetworkPolicy(handle: SandboxHandle, template: PolicyTemplateId, params: Record<string, string[]> = {}, credentials: CredentialGrant[] = []): Promise<void> {
    const c = await this.connect();
    const { policy } = renderPolicy(template, params);
    // Credentials first, so the new rules never go live without their binding.
    if (credentials.length) {
      const names = await this.ensureProviders({ credentials, identity: handle.identity }, handle.scope!);
      for (const n of names) {
        try { await c.sandbox.attachProvider(handle.name, n, { workspace: handle.scope }); }
        catch (e: any) { if (!/already attached|already exists/i.test(String(e?.message))) throw this.wrap(e, "credential attach"); }
      }
    }
    // Filesystem, Landlock and process settings are fixed at creation; only
    // network_policies change. Keep the rest byte-identical.
    let version = 0;
    try {
      const r = await c.sandbox.setPolicy(handle.name, this.policyMessage(policy), { workspace: handle.scope });
      version = r.version;
    } catch (e: any) {
      throw this.wrap(e, "policy update");
    }
    // The supervisor picks up a revision on its next settings poll (~10 s).
    // Report success only once the sandbox says it LOADED this version.
    const deadline = Date.now() + 60_000;
    for (;;) {
      const st = await c.raw.getSandboxPolicyStatus({ sandbox: handle.name, version, workspaceScope: { selection: { case: "workspace", value: handle.scope } } }).catch(() => null);
      const status = Number(st?.revision?.status ?? 0);
      if (status === 2 || Number(st?.activeVersion ?? 0) >= version) break; // LOADED
      if (status === 3) throw new SandboxError("tool_internal", `policy update failed to load: ${String(st?.revision?.loadError ?? "").slice(0, 200)}`, false);
      if (Date.now() > deadline) throw new SandboxError("sandbox_unavailable", "policy update was not loaded within 60 s");
      await new Promise((r) => setTimeout(r, 1000));
    }
    handle.policyTemplate = template;
  }

  async list() {
    const c = await this.connect();
    const refs: any[] = await c.sandbox.listAll({ allWorkspaces: true, labelSelector: "orvyn.ai/sandbox-id" });
    return refs.map((ref) => ({
      sandboxId: `sbx_${String(ref.labels?.["orvyn.ai/sandbox-id"] ?? "").replace(/^sbx_/, "")}`,
      name: ref.name, providerSandboxId: ref.id, state: stateFromPhase(ref.phase),
      createdAt: Number(ref.labels?.["orvyn.ai/created-at"]) || 0,
      labels: { ...(ref.labels ?? {}), "openshell.workspace": ref.workspace },
    }));
  }
}
