// apps/backend/src/ai/ToolTypes.ts
import type { ToolResultEnvelope } from "../gateway/toolResultEnvelope";
import type { ProjectFileEvidence } from "../artifacts/projectFileEvidence";
import { validateToolArguments, type ToolParameterSchema } from "./toolArgs";

export type ToolPermission = "allowed" | "ask" | "denied";

/**
 * The wire-level failure classification every tool result may carry. Defined
 * here (the contract layer) so tool implementations can declare WHAT failed;
 * agent/toolFailure.ts re-exports it and owns the classification helpers.
 */
export const TOOL_ERROR_TYPES = [
  "INVALID_ARGUMENTS",
  /** The tool needs a user/internal grant and none was carried — ask. */
  "APPROVAL_REQUIRED",
  /** User/org/project permission says no. */
  "PERMISSION_DENIED",
  /** Sandbox/security policy says no (distinct from permission policy). */
  "POLICY_DENIED",
  "CAPABILITY_UNAVAILABLE",
  "RESOURCE_MISSING",
  /** The bound workspace is missing, unbound, or the path escapes it. */
  "WORKSPACE_UNAVAILABLE",
  "WRITE_GUARD",
  "EXECUTION_FAILED",
  "TIMEOUT",
  /** The call was cancelled — do not retry or fail over. */
  "CANCELLED",
  /** The tool's own implementation broke — an alternate capability may still serve the goal. */
  "TOOL_INTERNAL",
  "TRANSIENT_PROVIDER_ERROR",
  "UNKNOWN",
] as const;

export type ToolErrorType = (typeof TOOL_ERROR_TYPES)[number];

export interface ToolResult {
  ok: boolean;
  output?: string;
  error?: string;
  /**
   * A tool that knows why it failed declares it here; the runtime prefers
   * this over re-inferring the class from the error text.
   */
  errorType?: ToolErrorType;
  /**
   * Diff metadata from a file-mutating tool (local or remote). Populated by
   * tools that can compute before/after (e.g. the remote edit adapter, which
   * reads the file on both sides of the mutation); consumed by the runtime to
   * emit file.edit events with a REAL diff. Structurally compatible with
   * agent/editPreview's EditPreview — duplicated here because ToolTypes is
   * the low-level layer and must not import from it.
   */
  edit?: {
    path: string;
    kind: "create" | "modify" | "delete" | "move";
    additions: number;
    deletions: number;
    diff?: Array<{ type: string; content: string }>;
    truncated?: boolean;
    note?: string;
  };
  /**
   * Set by ToolGateway on every execution: status, model payload, user
   * summary, structured data, evidence, retryable. Tools never set it.
   */
  envelope?: ToolResultEnvelope;
  /** Structured side-channel (capability.required, activation). Never secrets. */
  meta?: Record<string, unknown>;
  projectFileEvidence?: ProjectFileEvidence;
  /** Persisted file-producing results. Success requires artifactId on each entry. */
  artifacts?: Array<{
    artifactId: string;
    name: string;
    mimeType: string;
    size: number;
    sha256?: string;
    previewUrl?: string;
    downloadUrl?: string;
    kind?: string;
    projectFileEvidence?: ProjectFileEvidence;
  }>;
}

/**
 * Where the call executes. Open-ended (string & {}) so new providers —
 * OpenShell, microVMs — adopt the contract without churning it, while the
 * known values still get autocomplete at call sites.
 */
export type ExecutionTarget =
  | "local_host"
  | "local_sandbox"
  | "cloud_worker"
  | "remote_resource"
  | "ovh_worker"
  | "auto"
  | (string & {});

/**
 * Approval evidence. The registry fails closed on every "ask"-permission
 * tool call that reaches execute() without one of these: the caller must
 * carry proof that the grant it relies on exists — one-shot, mission-scoped,
 * or internally sanctioned.
 */
export interface ToolApproval {
  /** The caller asserts approval was obtained (or the call is internally sanctioned). */
  granted: boolean;
  /** once: this call only · mission: approved for the rest of the run · internal: sanctioned by the runtime itself (verifier, attachment staging, remote-bridge calls the remote side already approved). */
  scope: "once" | "mission" | "internal";
  /** The approval prompt / tool_use id the grant was issued against, when known. */
  approvalId?: string;
  /** Who approved — "user" for interactive grants, "policy" for mode auto-approve, "runtime" for internal calls. */
  grantedBy?: "user" | "policy" | "runtime";
}

/** Where a capability-provided tool came from (builtin, installed marketplace capability, connected MCP server, skill). */
export type CapabilitySource = { kind: "builtin" | "marketplace" | "mcp" | "skill"; id?: string };

/** A streamed output chunk from a long-running tool, with the stream it came from. */
export type ToolOutputChunk = { stream: "stdout" | "stderr"; data: string };

export interface ToolExecutionContext {
  signal?: AbortSignal;
  /** Combined-stream output callback (legacy). Prefer onOutputChunk for new tools. */
  onOutput?: (chunk: string) => void;
  /** Structured stdout/stderr streaming — preferred over onOutput. */
  onOutputChunk?: (chunk: ToolOutputChunk) => void;
  executionTarget?: ExecutionTarget;
  /** Local project workspace for this run. Not an SSH host and not the desktop filesystem. */
  workspaceRoot?: string;
  /** Stable workspace id for this run. */
  workspaceId?: string;
  /** The model's tool call id, carried into the result envelope. */
  toolUseId?: string;
  /** Canonical identifiers: org, tenant, project, run, mission, and task making the call. */
  organizationId?: string;
  tenantId?: string;
  projectId?: string | null;
  runId?: string;
  missionId?: string;
  taskId?: string;
  /** Session that owns this tool call — capability scoping keys off it. */
  sessionId?: string;
  /** MCP provenance — set by the caller for mcp.<server>.<tool> names. */
  mcpServerId?: string;
  /** Where the tool capability came from (builtin vs installed capability). */
  capability?: CapabilitySource;
  /** Approval evidence — REQUIRED on the context for "ask"-permission tools; the boundary fails closed without it. */
  approval?: ToolApproval;
  /** Write-safety context: what the user asked for (task scope) and which
   *  files this run has actually read. Authorization for a large rewrite is
   *  granted by runtime policy from these facts — never by the model's own
   *  assertion that a rewrite is intentional. */
  taskScope?: "full_redesign" | "targeted" | "unknown";
  filesReadThisRun?: Set<string>;
}

export interface AITool {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
  defaultPermission: ToolPermission;
  /** Provenance of this capability — capability routing and metrics learn per-source reliability. */
  source?: CapabilitySource;
  execute(args: Record<string, unknown>, context?: ToolExecutionContext): Promise<ToolResult>;
}

export class ToolRegistry {
  private tools = new Map<string, AITool>();
  // Permission overrides for THIS registry instance. Project/run isolation
  // comes from owning a scoped ToolGateway/ToolRegistry per tenant or run —
  // not from anything in this map.
  private permissions = new Map<string, ToolPermission>();

  register(tool: AITool): void {
    this.tools.set(tool.name, tool);
    this.permissions.set(tool.name, tool.defaultPermission);
  }

  clear(): void {
    this.tools.clear();
    this.permissions.clear();
  }

  /** Whether this registry instance owns a tool under this name. */
  has(toolName: string): boolean {
    return this.tools.has(toolName);
  }

  /** The registered tool, when this instance owns one under this name. */
  tool(toolName: string): AITool | undefined {
    return this.tools.get(toolName);
  }

  list(): AITool[] {
    return Array.from(this.tools.values());
  }

  /** Lookup seam — scoped overlays resolve through this so one name wins. */
  protected toolFor(toolName: string): AITool | undefined {
    return this.tools.get(toolName);
  }

  setPermission(toolName: string, permission: ToolPermission): void {
    this.permissions.set(toolName, permission);
  }

  /** Whether a permission was explicitly recorded on THIS registry. */
  hasPermissionEntry(toolName: string): boolean {
    return this.permissions.has(toolName);
  }

  getPermission(toolName: string): ToolPermission {
    return this.permissions.get(toolName) ?? "ask";
  }

  async execute(toolName: string, args: Record<string, unknown>, context?: ToolExecutionContext): Promise<ToolResult> {
    const tool = this.toolFor(toolName);
    if (!tool) return { ok: false, error: `Unknown tool "${toolName}"`, errorType: "CAPABILITY_UNAVAILABLE" };

    const permission = this.getPermission(toolName);
    if (permission === "denied") {
      return { ok: false, error: `Tool "${toolName}" is denied by project permissions`, errorType: "PERMISSION_DENIED" };
    }
    // "ask" fails CLOSED at this boundary: the tool layer never blocks on UI,
    // but it refuses to run unless the caller carries the approval grant it
    // obtained (one-shot, mission-scoped, or internally sanctioned). Callers
    // that skip the gate — a direct registry.execute, a forgotten context —
    // get APPROVAL_REQUIRED, not silent execution.
    if (permission === "ask" && context?.approval?.granted !== true) {
      return {
        ok: false,
        error: `Tool "${toolName}" requires approval and the caller carried no grant`,
        errorType: "APPROVAL_REQUIRED",
      };
    }
    // Arguments are part of the contract: every call that reaches the
    // registry is checked against the tool's schema. Malformed calls come
    // back INVALID_ARGUMENTS — fixable by the caller, never executed.
    const validation = validateToolArguments(toolName, args, tool.parameters as ToolParameterSchema | undefined);
    if (!validation.ok) {
      return { ok: false, error: validation.error, errorType: "INVALID_ARGUMENTS" };
    }
    return tool.execute(validation.args, context);
  }
}

/**
 * A run-scoped view over a tenant's base registry. The base's tools are
 * snapshot in by reference and its permissions copied at construction;
 * afterwards this instance evolves independently — mode/profile application,
 * remote-tool mounts and per-run denials are invisible to other runs and to
 * the base.
 *
 * Tools REGISTERED ON THE BASE after the snapshot (e.g. a mid-run MCP
 * install, which correctly writes to the tenant gateway) remain visible to
 * this run — a scoped run must see a capability it just installed. Their
 * permissions come from the base unless this run overrides them.
 */
export class ScopedToolRegistry extends ToolRegistry {
  constructor(private readonly base: ToolRegistry) {
    super();
    for (const tool of base.list()) {
      super.register(tool);
      super.setPermission(tool.name, base.getPermission(tool.name));
    }
  }

  override list(): AITool[] {
    // Mine first (run mounts override base entries of the same name), then
    // anything the base gained since the snapshot.
    const seen = new Map<string, AITool>();
    for (const t of super.list()) seen.set(t.name, t);
    for (const t of this.base.list()) if (!seen.has(t.name)) seen.set(t.name, t);
    return [...seen.values()];
  }

  override has(toolName: string): boolean {
    return super.has(toolName) || this.base.has(toolName);
  }

  protected override toolFor(toolName: string): AITool | undefined {
    return super.toolFor(toolName) ?? this.base.tool(toolName);
  }

  override getPermission(toolName: string): ToolPermission {
    return this.hasPermissionEntry(toolName) ? super.getPermission(toolName) : this.base.getPermission(toolName);
  }
}

// No module-level singleton: each tenant owns a ToolRegistry instance
// (see tenancy/TenantManager.ts) so tool state is never shared across customers.
