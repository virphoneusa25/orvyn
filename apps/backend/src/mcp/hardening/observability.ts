// Local MCP health, latency, circuit breaker, bounded restart. Telemetry
// stays on-device unless a future policy allows upload.

export type HealthLabel = "Healthy" | "Slow" | "Needs Auth" | "Offline" | "Error" | "Disabled" | "Blocked";

export interface ToolMetrics {
  calls: number;
  success: number;
  failure: number;
  lastUsedAt?: number;
  samples: number[];
}

export interface ServerHealth {
  serverId: string;
  status: HealthLabel;
  lastConnectedAt?: number;
  lastFailureAt?: number;
  latencyMs?: number;
  toolCount: number;
  restartCount: number;
  circuitOpenUntil?: number;
  circuitReason?: string;
  tools: Record<string, { calls: number; success: number; failure: number; p50?: number; p95?: number; lastUsedAt?: number }>;
}

const MAX_SAMPLES = 40;
const CIRCUIT_FAILS = 5;
const CIRCUIT_WINDOW_MS = 60_000;
const CIRCUIT_OPEN_MS = 30_000;
const MAX_RESTARTS = 3;
const BACKOFF_MS = [1_000, 4_000, 16_000];

export class McpObservability {
  private tools = new Map<string, ToolMetrics>();
  private fails = new Map<string, number[]>();
  private circuit = new Map<string, { until: number; reason: string }>();
  private restarts = new Map<string, number>();
  private lastFail = new Map<string, number>();
  private lastOk = new Map<string, number>();

  record(serverId: string, tool: string, ok: boolean, durationMs: number): void {
    const key = `${serverId}:${tool}`;
    const row = this.tools.get(key) ?? { calls: 0, success: 0, failure: 0, samples: [] };
    row.calls += 1;
    if (ok) row.success += 1;
    else row.failure += 1;
    row.lastUsedAt = Date.now();
    row.samples.push(durationMs);
    if (row.samples.length > MAX_SAMPLES) row.samples.shift();
    this.tools.set(key, row);
    if (ok) {
      this.lastOk.set(serverId, Date.now());
      const f = this.fails.get(serverId) ?? [];
      this.fails.set(serverId, f.filter((t) => Date.now() - t < CIRCUIT_WINDOW_MS));
    } else {
      this.lastFail.set(serverId, Date.now());
      const f = [...(this.fails.get(serverId) ?? []), Date.now()].filter((t) => Date.now() - t < CIRCUIT_WINDOW_MS);
      this.fails.set(serverId, f);
      if (f.length >= CIRCUIT_FAILS) {
        this.circuit.set(serverId, { until: Date.now() + CIRCUIT_OPEN_MS, reason: `${f.length} failures in 60s` });
      }
    }
  }

  circuitOpen(serverId: string, now = Date.now()): string | null {
    const c = this.circuit.get(serverId);
    if (!c) return null;
    if (now >= c.until) {
      this.circuit.delete(serverId);
      return null;
    }
    return c.reason;
  }

  canRestart(serverId: string): { ok: boolean; waitMs: number; reason?: string } {
    const n = this.restarts.get(serverId) ?? 0;
    if (n >= MAX_RESTARTS) return { ok: false, waitMs: 0, reason: `Restart budget exhausted (${MAX_RESTARTS})` };
    return { ok: true, waitMs: BACKOFF_MS[Math.min(n, BACKOFF_MS.length - 1)] };
  }

  noteRestart(serverId: string): void {
    this.restarts.set(serverId, (this.restarts.get(serverId) ?? 0) + 1);
  }

  resetRestarts(serverId: string): void {
    this.restarts.set(serverId, 0);
  }

  snapshot(serverId: string, input: { state: string; toolCount: number; lastConnectedAt?: number; enabled: boolean; blocked?: boolean }): ServerHealth {
    const circuit = this.circuit.get(serverId);
    let status: HealthLabel = "Offline";
    if (input.blocked) status = "Blocked";
    else if (!input.enabled || input.state === "DISABLED") status = "Disabled";
    else if (input.state === "NEEDS_AUTH") status = "Needs Auth";
    else if (input.state === "ERROR") status = "Error";
    else if (input.state === "CONNECTED") {
      const lat = this.p95ForServer(serverId);
      status = lat != null && lat > 2_500 ? "Slow" : "Healthy";
    }
    const tools: ServerHealth["tools"] = {};
    for (const [key, row] of this.tools) {
      if (!key.startsWith(`${serverId}:`)) continue;
      const sorted = [...row.samples].sort((a, b) => a - b);
      tools[key.slice(serverId.length + 1)] = {
        calls: row.calls,
        success: row.success,
        failure: row.failure,
        lastUsedAt: row.lastUsedAt,
        p50: percentile(sorted, 0.5),
        p95: percentile(sorted, 0.95),
      };
    }
    return {
      serverId,
      status,
      lastConnectedAt: input.lastConnectedAt ?? this.lastOk.get(serverId),
      lastFailureAt: this.lastFail.get(serverId),
      latencyMs: this.p95ForServer(serverId),
      toolCount: input.toolCount,
      restartCount: this.restarts.get(serverId) ?? 0,
      circuitOpenUntil: circuit && circuit.until > Date.now() ? circuit.until : undefined,
      circuitReason: circuit && circuit.until > Date.now() ? circuit.reason : undefined,
      tools,
    };
  }

  private p95ForServer(serverId: string): number | undefined {
    const samples: number[] = [];
    for (const [key, row] of this.tools) {
      if (key.startsWith(`${serverId}:`)) samples.push(...row.samples);
    }
    if (!samples.length) return undefined;
    return percentile([...samples].sort((a, b) => a - b), 0.95);
  }
}

function percentile(sorted: number[], p: number): number | undefined {
  if (!sorted.length) return undefined;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1));
  return sorted[i];
}
