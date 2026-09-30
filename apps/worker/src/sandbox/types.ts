// apps/worker/src/sandbox/types.ts
//
// The execution-sandbox seam. ORVYN's control plane (model loop, tools,
// tenancy, billing, verification) stays exactly where it is; this interface
// only decides WHERE a mission's commands run. Two implementations:
//
//   docker    — the existing hardened container (default, always available)
//   openshell — an NVIDIA OpenShell sandbox behind a private gateway
//               (opt-in per organization, canary first)
//
// Nothing here is customer-facing. Provider names never reach the portal.

export type ExecutionProviderId = "docker" | "openshell";

/** ORVYN's own lifecycle vocabulary. Provider phases map onto this. */
export type SandboxState =
  | "provisioning"
  | "ready"
  | "running"
  | "degraded"
  | "recovering"
  | "completed"
  | "failed"
  | "stopping"
  | "stopped";

export type RetentionPolicy = "ephemeral" | "retained";

/** Versioned network policy templates (see ./policies). */
export type PolicyTemplateId =
  | "code-basic"
  | "web-development"
  | "research"
  | "github"
  | "deployment"
  | "server-admin";

/** Immutable identity of the mission a sandbox serves. Never client-supplied. */
export interface SandboxIdentity {
  organizationId: string;
  tenantId: string;
  userId: string;
  projectId: string | null;
  /** ORVYN workspace id (the durable workspace this run was bound to). */
  workspaceId: string;
  missionId?: string;
  runId?: string;
}

/** Plan-tier limits. Chosen by the control plane, never by the client or model. */
export interface SandboxResources {
  cpus: number;
  memoryMb: number;
  pidsLimit: number;
  /** Default per-command timeout. */
  commandTimeoutS: number;
  /** Hard ceiling on the sandbox's life (TTL). */
  maxLifetimeS: number;
}

export interface CreateSandboxSpec {
  /** ORVYN's immutable sandbox id (sbx_…). The registry key. */
  sandboxId: string;
  identity: SandboxIdentity;
  /** Host path of the ONE authorized workspace. Mounted at /workspace, nothing else. */
  workspaceHostPath: string;
  image?: string;
  resources: SandboxResources;
  policyTemplate: PolicyTemplateId;
  retention: RetentionPolicy;
  /** Non-secret environment only. Secrets go through credential brokering. */
  env?: Record<string, string>;
  /** Credential grants already authorized by the control plane (openshell only). */
  credentials?: CredentialGrant[];
}

/** A provider-side credential bundle scoped to one organization + integration. */
export interface CredentialGrant {
  organizationId: string;
  integrationId: string;
  /** Provider profile type, e.g. "github". */
  type: string;
}

export interface SandboxHandle {
  sandboxId: string;
  provider: ExecutionProviderId;
  /** The provider's own id (container id / OpenShell sandbox id). */
  providerSandboxId: string;
  /** Provider-side name (deterministic from sandboxId, so it can be found again). */
  name: string;
  identity: SandboxIdentity;
  state: SandboxState;
  createdAt: number;
  policyTemplate: PolicyTemplateId;
  policyVersion: number;
  retention: RetentionPolicy;
  /** Provider-side scope (OpenShell workspace name); empty for docker. */
  scope?: string;
  /** Milliseconds from create to ready. */
  provisionMs?: number;
}

export interface ExecOptions {
  /** Directory inside the sandbox. Defaults to /workspace. */
  cwd?: string;
  env?: Record<string, string>;
  timeoutS?: number;
  stdin?: string;
  signal?: AbortSignal;
  onOutput?: (chunk: string, stream: "stdout" | "stderr") => void;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  startedAt: number;
  completedAt: number;
  timedOut: boolean;
  signal?: string;
}

/** An interactive shell attached to the sandbox (terminal panel). */
export interface AttachSession {
  write(data: string): void;
  onData(cb: (chunk: string) => void): void;
  resize?(cols: number, rows: number): void;
  close(): Promise<void>;
  exited: Promise<number>;
}

export interface RuntimeCapabilities {
  filesystem: boolean;
  terminal: boolean;
  attach: boolean;
  /** "none": no network at all. "policy": deny-by-default with allow-listed templates. */
  network: "none" | "policy";
  networkPolicyTemplates: PolicyTemplateId[];
  liveNetworkPolicyUpdate: boolean;
  credentialBroker: boolean;
  reconnect: boolean;
  retainedSandboxes: boolean;
  browser: boolean;
  gpu: boolean;
}

export interface ProviderHealth {
  provider: ExecutionProviderId;
  healthy: boolean;
  version?: string;
  detail?: string;
  latencyMs?: number;
  checkedAt: number;
}

export interface ExecutionSandboxProvider {
  readonly id: ExecutionProviderId;
  createSandbox(spec: CreateSandboxSpec): Promise<SandboxHandle>;
  /** Finds a live sandbox again (after a worker restart). Null when it is gone. */
  getSandbox(sandboxId: string, identity: SandboxIdentity): Promise<SandboxHandle | null>;
  exec(handle: SandboxHandle, command: string, opts?: ExecOptions): Promise<ExecResult>;
  attach(handle: SandboxHandle, opts?: { cols?: number; rows?: number }): Promise<AttachSession>;
  stop(handle: SandboxHandle): Promise<void>;
  destroy(handle: SandboxHandle): Promise<void>;
  getCapabilities(): RuntimeCapabilities;
  getHealth(): Promise<ProviderHealth>;
  /** Every ORVYN-owned sandbox this provider knows about (reconciliation). */
  list(): Promise<Array<{ sandboxId: string; name: string; providerSandboxId: string; state: SandboxState; createdAt: number; labels: Record<string, string> }>>;
  /** Replace the live network policy with an approved template (openshell only). */
  updateNetworkPolicy?(handle: SandboxHandle, template: PolicyTemplateId, params?: Record<string, string[]>, credentials?: CredentialGrant[]): Promise<void>;
}

/**
 * Failure classes. The runtime uses them to decide what to do next:
 * only provider_model_failure may switch models; policy denials never do.
 */
export type SandboxFailureKind =
  | "tool_bad_args"
  | "tool_internal"
  | "sandbox_unavailable"
  | "network_policy_denied"
  | "credential_policy_denied"
  | "provider_model_failure";

export class SandboxError extends Error {
  constructor(
    public readonly kind: SandboxFailureKind,
    message: string,
    public readonly retryable = kind === "sandbox_unavailable",
  ) {
    super(message);
    this.name = "SandboxError";
  }
}

export const ALL_TEMPLATES: PolicyTemplateId[] = [
  "code-basic", "web-development", "research", "github", "deployment", "server-admin",
];

export function isPolicyTemplate(v: unknown): v is PolicyTemplateId {
  return typeof v === "string" && (ALL_TEMPLATES as string[]).includes(v);
}
