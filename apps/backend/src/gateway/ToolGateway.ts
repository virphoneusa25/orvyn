// apps/backend/src/gateway/ToolGateway.ts
//
// The ONLY path through which agents execute tools. It layers the capability
// check (PermissionEngine, per agent role) on top of the per-project
// allowed/ask/denied registry. Agents never hold a ToolRegistry directly —
// they hold this gateway, so nothing can skip the permission stack.

import { AITool, ToolExecutionContext, ToolPermission, ToolRegistry, ToolResult } from "../ai/ToolTypes";
import { AgentRole, PermissionEngine } from "./PermissionEngine";
import { applyProfile, PermissionProfile } from "./PermissionProfiles";
import { cloudFilesystemDecision } from "./executionBoundary";
import { buildToolResultEnvelope } from "./toolResultEnvelope";

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
   *
   * Every result comes back wrapped: `result.envelope` carries status, model
   * payload, user summary, structured data, evidence and retryable. A tool
   * that throws becomes an error result instead of a rejected promise.
   */
  async execute(
    toolName: string,
    args: Record<string, unknown>,
    role?: AgentRole,
    context?: ToolExecutionContext
  ): Promise<ToolResult> {
    const started = Date.now();
    const wrap = (result: ToolResult, blocked = false): ToolResult => ({
      ...result,
      envelope: buildToolResultEnvelope({
        toolName,
        args: args ?? {},
        result,
        toolUseId: context?.toolUseId,
        workspaceRoot: context?.workspaceRoot,
        durationMs: Date.now() - started,
        blocked,
        cancelled: !result.ok && Boolean(context?.signal?.aborted),
      }),
    });

    const verdict = this.permissions.checkRole(toolName, role);
    if (!verdict.allowed) {
      return wrap({ ok: false, error: verdict.reason ?? "Denied by capability policy" }, true);
    }
    if (/^(write_file|read_file|edit_file|delete_file)$/.test(toolName)) {
      const decision = cloudFilesystemDecision(
        context?.executionTarget,
        String(args.path ?? args.file ?? ""),
        context?.workspaceRoot ?? ""
      );
      if (!decision.ok) return wrap({ ok: false, error: `${decision.code}: ${decision.error}` }, true);
    }
    let result: ToolResult;
    try {
      result = await this.registry.execute(toolName, args, context);
    } catch (err) {
      result = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    const denied = !result.ok && /^Tool "[^"]+" is denied/.test(String(result.error ?? ""));
    return wrap(result, denied);
  }
}
