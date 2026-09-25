// apps/backend/src/ai/ToolTypes.ts
import type { ToolResultEnvelope } from "../gateway/toolResultEnvelope";

export type ToolPermission = "allowed" | "ask" | "denied";

export interface ToolResult {
  ok: boolean;
  output?: string;
  error?: string;
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
  }>;
}

export interface ToolExecutionContext {
  signal?: AbortSignal;
  onOutput?: (chunk: string) => void;
  executionTarget?: string;
  workspaceRoot?: string;
  /** The model's tool call id, carried into the result envelope. */
  toolUseId?: string;
  /** The run and tenant making the call (browser sessions are per run). */
  runId?: string;
  tenantId?: string;
}

export interface AITool {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
  defaultPermission: ToolPermission;
  execute(args: Record<string, unknown>, context?: ToolExecutionContext): Promise<ToolResult>;
}

export class ToolRegistry {
  private tools = new Map<string, AITool>();
  // Per-project permission overrides, keyed by tool name.
  private permissions = new Map<string, ToolPermission>();

  register(tool: AITool): void {
    this.tools.set(tool.name, tool);
    this.permissions.set(tool.name, tool.defaultPermission);
  }

  clear(): void {
    this.tools.clear();
    this.permissions.clear();
  }

  list(): AITool[] {
    return Array.from(this.tools.values());
  }

  setPermission(toolName: string, permission: ToolPermission): void {
    this.permissions.set(toolName, permission);
  }

  getPermission(toolName: string): ToolPermission {
    return this.permissions.get(toolName) ?? "ask";
  }

  async execute(toolName: string, args: Record<string, unknown>, context?: ToolExecutionContext): Promise<ToolResult> {
    const tool = this.tools.get(toolName);
    if (!tool) return { ok: false, error: `Unknown tool "${toolName}"` };

    const permission = this.getPermission(toolName);
    if (permission === "denied") {
      return { ok: false, error: `Tool "${toolName}" is denied by project permissions` };
    }
    // "ask" is enforced by the caller (route handler) which must have already
    // obtained explicit user approval before invoking execute() — the tool
    // layer itself never blocks on UI, it only refuses when flatly denied.
    return tool.execute(args, context);
  }
}

// No module-level singleton: each tenant owns a ToolRegistry instance
// (see tenancy/TenantManager.ts) so tool state is never shared across customers.
