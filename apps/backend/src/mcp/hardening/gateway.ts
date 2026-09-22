// Cloud MCP Gateway: tenant-bound invoke. Secrets stay on the control plane.
// Local stdio is never pretended to be reachable from OVH.

import type { McpManager } from "../McpManager";
import { adminToolDenied, denyStartReason, type McpEnterprisePolicy } from "./policy";
import type { McpObservability } from "./observability";

export interface GatewayInvokeInput {
  tenantId: string;
  expectedTenantId: string;
  serverId: string;
  tool: string;
  args: Record<string, unknown>;
  runId?: string;
  projectRoot?: string | null;
  cloudRun?: boolean;
}

export interface GatewayInvokeResult {
  ok: boolean;
  output?: string;
  error?: string;
  durationMs: number;
  executionLocation: "local" | "cloud" | "remote";
}

export class McpCloudGateway {
  /** Set false to simulate an outage — cloud MCP fails truthfully, no local fallback. */
  available = true;

  constructor(
    private manager: McpManager,
    private policy: () => McpEnterprisePolicy,
    private obs: McpObservability
  ) {}

  async invoke(input: GatewayInvokeInput): Promise<GatewayInvokeResult> {
    const started = Date.now();
    if (!this.available) {
      return {
        ok: false,
        error: "MCP Gateway unavailable. Cloud MCP is not reachable. There is no local fallback.",
        durationMs: 0,
        executionLocation: "remote",
      };
    }
    if (input.tenantId !== input.expectedTenantId) {
      return { ok: false, error: "Tenant isolation: this MCP connection is not visible to the caller.", durationMs: 0, executionLocation: "remote" };
    }
    const cfg = this.manager.listServers().find((s) => s.id === input.serverId);
    if (!cfg) return { ok: false, error: "Unknown MCP server for this tenant", durationMs: Date.now() - started, executionLocation: "remote" };

    const deny = denyStartReason(this.policy(), {
      id: cfg.id,
      marketplaceId: cfg.marketplaceId,
      packageIdentifier: cfg.packageIdentifier,
      sourceProviders: cfg.sourceProviders,
    });
    if (deny) return { ok: false, error: deny, durationMs: Date.now() - started, executionLocation: cfg.executionLocation ?? "local" };

    if (adminToolDenied(this.policy(), input.tool)) {
      return { ok: false, error: `Admin hard deny: ${input.tool} cannot run (overrides Full Access).`, durationMs: Date.now() - started, executionLocation: cfg.executionLocation ?? "local" };
    }

    if (cfg.scope === "project" && input.projectRoot && cfg.cwd && !pathsAligned(cfg.cwd, input.projectRoot)) {
      return { ok: false, error: "This MCP server is scoped to another project.", durationMs: Date.now() - started, executionLocation: cfg.executionLocation ?? "local" };
    }

    const location = cfg.executionLocation ?? (cfg.transport === "http" ? "remote" : "local");
    if (input.cloudRun && location === "local") {
      return {
        ok: false,
        error: "Local Only — this stdio MCP runs on the desktop and is not reachable from OVH. Use a remote Streamable HTTP server or a cloud MCP runtime.",
        durationMs: Date.now() - started,
        executionLocation: "local",
      };
    }

    const trip = this.obs.circuitOpen(cfg.id);
    if (trip) {
      return { ok: false, error: `Circuit open: ${trip}`, durationMs: Date.now() - started, executionLocation: location };
    }

    const namespaced = input.tool.startsWith("mcp.") ? input.tool : null;
    const original = namespaced ? input.tool.split(".").slice(2).join(".") : input.tool;
    const status = this.manager.status(cfg.id);
    const tool = status?.tools.find((t) => t.name === original || `mcp.${sanitize(cfg.name)}.${sanitize(t.name)}` === input.tool);
    if (!tool) {
      return { ok: false, error: `Tool ${input.tool} is not connected on ${cfg.name}`, durationMs: Date.now() - started, executionLocation: location };
    }

    const timeoutMs = Number(process.env.ORVYN_MCP_CALL_TIMEOUT_MS) || 120_000;
    const result = await Promise.race([
      this.manager.invokeDiscoveredTool(cfg.id, tool.name, input.args),
      new Promise<{ ok: boolean; output: string; error?: string }>((resolve) =>
        setTimeout(() => resolve({ ok: false, output: "", error: `MCP call timed out after ${timeoutMs}ms` }), timeoutMs)
      ),
    ]);
    this.obs.record(cfg.id, tool.name, result.ok, Date.now() - started);
    return { ...result, durationMs: Date.now() - started, executionLocation: location };
  }
}

function sanitize(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 48);
}

function pathsAligned(a: string, b: string): boolean {
  const na = a.replace(/\\/g, "/").replace(/\/$/, "").toLowerCase();
  const nb = b.replace(/\\/g, "/").replace(/\/$/, "").toLowerCase();
  return na === nb || na.startsWith(nb + "/") || nb.startsWith(na + "/");
}
