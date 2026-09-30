// apps/backend/src/capabilities/registry.ts
//
// §17 (the 75-point spec): ONE canonical capability registry that unifies
// native ORVYN tools, installed Skills, connected MCP servers, and sandbox
// commands under a single shape. The runtime uses it for tool selection
// (priority: core → skill → mcp → shell workaround), the admin view uses it
// for explainability, and the model sees a filtered manifest — not every
// tool in the system.

export type CapabilitySource = "core" | "skill" | "mcp" | "integration" | "sandbox";
export type CapabilityId =
  | "file.read" | "file.write" | "file.patch" | "file.search"
  | "symbol.search" | "semantic.search"
  | "git.status" | "git.diff" | "git.show"
  | "shell.run"
  | "browser.open" | "browser.dom" | "browser.console" | "browser.network" | "browser.screenshot"
  | "preview.start" | "preview.status"
  | (string & {});

export type FailureClass =
  | "INVALID_ARGUMENTS" | "NOT_FOUND" | "PERMISSION" | "WORKSPACE_UNAVAILABLE"
  | "TIMEOUT" | "POLICY_DENIED" | "MCP_UNAVAILABLE" | "TOOL_INTERNAL_ERROR";

export interface Capability {
  /** Canonical id, e.g. "file.read", or the MCP tool's namespaced id. */
  id: CapabilityId;
  name: string;
  source: CapabilitySource;
  description: string;
  /** Which task categories this capability is relevant for (empty = all). */
  taskTypes: string[];
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  permissions: string[];
  requiredRuntimeCapabilities?: string[];
  health: "available" | "degraded" | "unavailable";
  /** 0–1 rolling success rate (from run events; new entries start at 1). */
  reliability: number;
  latencyClass: "fast" | "medium" | "slow";
  costClass: "free" | "cheap" | "moderate" | "expensive";
  /** The concrete tool name the gateway dispatches to. */
  dispatchTool: string;
  /** Why this capability was (or was not) selected — admin explainability. */
  selectionReason?: string;
}

/** Selection priority: core → skill → mcp → sandbox. Lower wins. */
const SOURCE_PRIORITY: Record<CapabilitySource, number> = {
  core: 0, skill: 1, mcp: 2, integration: 2, sandbox: 3,
};

export class CapabilityRegistry {
  /** Multiple sources can provide the SAME capability (core + mcp + sandbox). */
  private readonly entries = new Map<string, Capability[]>();

  register(cap: Capability): void {
    const list = this.entries.get(cap.id) ?? [];
    const at = list.findIndex((c) => c.source === cap.source);
    if (at >= 0) list[at] = cap; else list.push(cap);
    this.entries.set(cap.id, list);
  }

  unregister(id: string, source?: CapabilitySource): void {
    if (!source) { this.entries.delete(id); return; }
    const list = (this.entries.get(id) ?? []).filter((c) => c.source !== source);
    if (list.length) this.entries.set(id, list); else this.entries.delete(id);
  }

  get(id: string): Capability | undefined {
    return this.select(id)?.capability;
  }

  list(): Capability[] {
    return this.entries.values().next().value ? [...this.entries.values()].flat() : [];
  }

  /**
   * The capability to use for a need, honoring:
   *  - health (unavailable capabilities are skipped),
   *  - task-type relevance (empty taskTypes = always relevant),
   *  - source priority (core before skill before mcp before sandbox).
   * Returns the winner plus a one-line reason (admin explainability).
   */
  select(need: CapabilityId | string, taskType?: string): { capability: Capability; reason: string } | null {
    const relevant = (this.entries.get(need) ?? [])
      .concat(this.list().filter((c) => c.id !== need && (c.taskTypes.includes("*") || (taskType ? c.taskTypes.includes(taskType) : false))));
    const healthy = relevant.filter((c) => c.health !== "unavailable");
    if (!healthy.length) return null;
    const sorted = healthy.sort((a, b) =>
      (SOURCE_PRIORITY[a.source] - SOURCE_PRIORITY[b.source]) || (b.reliability - a.reliability)
    );
    const winner = sorted[0]!;
    const skipped = sorted.slice(1).map((c) => `${c.id} (${c.source}, lower priority or reliability)`);
    const reason = [
      `Selected ${winner.id} [${winner.source}]`,
      winner.health === "degraded" ? "(degraded — best available)" : "",
      skipped.length ? `over ${skipped.join(", ")}` : "as the only capable entry",
    ].filter(Boolean).join(" — ");
    winner.selectionReason = reason;
    return { capability: winner, reason };
  }

  /** Deterministic routing for obvious needs (§30): exact id, healthy, highest priority. */
  route(need: CapabilityId | string, taskType?: string): Capability | null {
    return this.select(need, taskType)?.capability ?? null;
  }

  /** Update rolling health/reliability from an execution result. */
  reportResult(id: string, ok: boolean, health?: Capability["health"]): void {
    for (const cap of this.entries.get(id) ?? []) {
      // Exponential moving average, α = 0.2.
      cap.reliability = Math.round(((cap.reliability * 0.8) + (ok ? 1 : 0) * 0.2) * 100) / 100;
      if (health) cap.health = health;
    }
  }
}
