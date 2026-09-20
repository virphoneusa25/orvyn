// apps/backend/src/ai/ToolTypes.ts

export type ToolPermission = "allowed" | "ask" | "denied";

export interface ToolResult {
  ok: boolean;
  output?: string;
  error?: string;
}

export interface ToolExecutionContext {
  signal?: AbortSignal;
  onOutput?: (chunk: string) => void;
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
