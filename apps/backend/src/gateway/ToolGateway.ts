// apps/backend/src/gateway/ToolGateway.ts
//
// The ONLY path through which agents execute tools. It layers the capability
// check (PermissionEngine, per agent role) on top of the per-project
// allowed/ask/denied registry. Agents never hold a ToolRegistry directly —
// they hold this gateway, so nothing can skip the permission stack.

import { AITool, ToolPermission, ToolRegistry, ToolResult } from "../ai/ToolTypes";
import { AgentRole, PermissionEngine } from "./PermissionEngine";
import { applyProfile, PermissionProfile } from "./PermissionProfiles";

export class ToolGateway {
  /** User-selected autonomy profile (spec §47). SAFE = ask for everything risky. */
  profile: PermissionProfile = "SAFE";

  constructor(
    /** Exposed for applyMode(), which rewrites per-run permission profiles. */
    public readonly registry: ToolRegistry,
    public readonly permissions: PermissionEngine
  ) {}

  /** Apply the current autonomy profile on top of whatever mode just set. */
  applyProfile(): void {
    applyProfile(this.registry, this.profile);
  }

  register(tool: AITool): void {
    this.registry.register(tool);
  }

  /**
   * Registers a second name for an existing tool (e.g. `run_command` →
   * `terminal`) so prompts written against either name keep working.
   */
  registerAlias(alias: string, target: string): void {
    const t = this.registry.list().find((x) => x.name === target);
    if (!t) return;
    this.registry.register({
      ...t,
      name: alias,
      description: `${t.description} (alias of ${target})`,
    });
  }

  list(): AITool[] {
    return this.registry.list();
  }

  getPermission(toolName: string): ToolPermission {
    return this.registry.getPermission(toolName);
  }

  setPermission(toolName: string, permission: ToolPermission): void {
    this.registry.setPermission(toolName, permission);
  }

  /**
   * Execute with the full permission stack:
   * 1. role capability check (if a role is supplied),
   * 2. registry allowed/ask/denied ("ask" approval is obtained by the caller
   *    BEFORE calling execute — the gateway refuses only flat denials).
   */
  async execute(
    toolName: string,
    args: Record<string, unknown>,
    role?: AgentRole
  ): Promise<ToolResult> {
    const verdict = this.permissions.checkRole(toolName, role);
    if (!verdict.allowed) {
      return { ok: false, error: verdict.reason ?? "Denied by capability policy" };
    }
    return this.registry.execute(toolName, args);
  }
}
