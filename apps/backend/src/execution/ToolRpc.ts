import { randomUUID } from "crypto";

export type ToolRpcState = "pending" | "leased" | "executing" | "completed" | "failed" | "uncertain";

export interface ToolRpcRequest {
  requestId: string;
  runId: string;
  tenantId?: string;
  tool: string;
  arguments: Record<string, unknown>;
  timeoutMs: number;
  createdAt: number;
  leaseOwner?: string;
  leaseId?: string;
  leaseExpiresAt?: number;
  attempts?: number;
}

export type ToolRequest = ToolRpcRequest;

export interface ToolResponse {
  requestId: string;
  runId: string;
  ok: boolean;
  output?: string;
  stderr?: string;
  exitCode?: number;
  error?: string;
  meta?: Record<string, unknown>;
  durationMs: number;
}

export interface DurableToolRpcStore {
  createToolRpcCommand(input: { requestId: string; runId: string; tenantId: string; tool: string; argumentsJson: string; timeoutMs: number; createdAt: number }): unknown | Promise<unknown>;
  claimToolRpcCommand(tenantId: string, runId: string, workerId: string, now: number, leaseMs: number, maxAttempts: number): any | Promise<any>;
  beginToolRpcCommand(tenantId: string, runId: string, requestId: string, workerId: string, leaseId: string, now: number): unknown | Promise<unknown>;
  heartbeatToolRpcCommand(tenantId: string, runId: string, requestId: string, workerId: string, leaseId: string, now: number, leaseMs: number): unknown | Promise<unknown>;
  settleToolRpcCommand(tenantId: string, runId: string, requestId: string, workerId: string, leaseId: string, status: string, resultJson: string, now: number): unknown | Promise<unknown>;
  failPendingToolRpc(tenantId: string, runId: string, error: string, now: number): unknown | Promise<unknown>;
  markToolRpcUncertain(tenantId: string, runId: string, requestId: string, error: string, now: number): unknown | Promise<unknown>;
  markToolRpcRunUncertain(tenantId: string, runId: string, error: string, now: number): unknown | Promise<unknown>;
  loadToolRpcCommand(tenantId: string, runId: string, requestId: string): any | Promise<any>;
}

type Pending = {
  request: ToolRequest;
  resolve: (response: ToolResponse) => void;
  timer: NodeJS.Timeout;
};

const LEASE_MS = 45_000;
const MAX_ATTEMPTS = 3;

function value<T>(result: T | Promise<T>): Promise<T> {
  return Promise.resolve(result);
}

/** Durable tenant-scoped request journal. In-memory promises are wait handles only. */
export class ToolRpcChannel {
  private readonly queues = new Map<string, ToolRequest[]>();
  private readonly pending = new Map<string, Pending>();
  private readonly inFlight = new Set<string>();
  private resolveStore?: (tenantId: string) => DurableToolRpcStore | Promise<DurableToolRpcStore> | undefined;

  setPersistenceResolver(resolve: (tenantId: string) => DurableToolRpcStore | Promise<DurableToolRpcStore> | undefined): void {
    this.resolveStore = resolve;
  }

  private async store(tenantId?: string): Promise<DurableToolRpcStore | undefined> {
    return tenantId ? this.resolveStore?.(tenantId) : undefined;
  }

  async execute(
    runId: string,
    tool: string,
    args: Record<string, unknown>,
    timeoutMs = 60_000,
    tenantId?: string,
  ): Promise<ToolResponse> {
    const request: ToolRequest = { requestId: randomUUID(), runId, tenantId, tool, arguments: args, timeoutMs, createdAt: Date.now() };
    if (tenantId) {
      const store = await this.store(tenantId);
      if (!store) throw new Error(`Durable ToolRpc storage unavailable for tenant ${tenantId}`);
      await value(store.createToolRpcCommand({ requestId: request.requestId, runId, tenantId, tool, argumentsJson: JSON.stringify(args), timeoutMs, createdAt: request.createdAt }));
    }

    return new Promise<ToolResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(request.requestId);
        this.inFlight.delete(request.requestId);
        if (tenantId) {
          void this.store(tenantId).then((store) => store && value(store.markToolRpcUncertain(tenantId, runId, request.requestId, "control plane timed out while execution outcome was unresolved", Date.now())))
            .catch((error) => console.error("[tool-rpc] timeout persistence failed", { tenantId, runId, requestId: request.requestId, error: String(error) }));
        }
        reject(new Error(`Remote tool "${tool}" timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(request.requestId, { request, resolve, timer });
      if (!tenantId) {
        const queue = this.queues.get(runId) ?? [];
        queue.push(request);
        this.queues.set(runId, queue);
      }
      console.info(JSON.stringify({ event: "tool_rpc.command.created", tenantId: tenantId ?? "test-memory", runId, requestId: request.requestId, tool, state: tenantId ? "pending" : "pending-memory" }));
    });
  }

  /** Workers claim persisted commands with expiring, owner-fenced leases. */
  async claim(runId: string, tenantId: string, workerId: string): Promise<ToolRequest | null> {
    const store = await this.store(tenantId);
    if (!store) return this.poll(runId);
    const row = await value(store.claimToolRpcCommand(tenantId, runId, workerId, Date.now(), LEASE_MS, MAX_ATTEMPTS));
    if (!row) return null;

    let args: Record<string, unknown>;
    try {
      args = JSON.parse(row.arguments_json);
    } catch {
      await this.failRun(runId, "Stored ToolRpc arguments were invalid", tenantId);
      return null;
    }
    const request: ToolRequest = {
      requestId: String(row.request_id), runId: String(row.run_id), tenantId,
      tool: String(row.tool), arguments: args, timeoutMs: Number(row.timeout_ms), createdAt: Number(row.created_at),
      leaseOwner: String(row.lease_owner), leaseId: String(row.lease_id), leaseExpiresAt: Number(row.lease_expires_at), attempts: Number(row.attempts),
    };
    console.info(JSON.stringify({ event: "tool_rpc.command.leased", tenantId, runId, requestId: request.requestId, tool: request.tool, workerId, attempt: request.attempts }));
    return request;
  }

  async begin(request: ToolRequest, tenantId: string, workerId: string, leaseId: string): Promise<boolean> {
    const store = await this.store(tenantId);
    if (!store) {
      this.inFlight.add(request.requestId);
      return true;
    }
    const ok = Boolean(await value(store.beginToolRpcCommand(tenantId, request.runId, request.requestId, workerId, leaseId, Date.now())));
    if (ok) this.inFlight.add(request.requestId);
    console.info(JSON.stringify({ event: "tool_rpc.command.executing", tenantId, runId: request.runId, requestId: request.requestId, ok }));
    return ok;
  }

  async heartbeat(request: ToolRequest, tenantId: string, workerId: string, leaseId: string): Promise<boolean> {
    const store = await this.store(tenantId);
    if (!store) return false;
    return Boolean(await value(store.heartbeatToolRpcCommand(tenantId, request.runId, request.requestId, workerId, leaseId, Date.now(), LEASE_MS)));
  }

  async settle(response: ToolResponse, tenantId: string, workerId: string, leaseId: string): Promise<boolean> {
    const store = await this.store(tenantId);
    if (!store) return this.resolve(response);
    const resultJson = JSON.stringify(response);
    const ok = Boolean(await value(store.settleToolRpcCommand(tenantId, response.runId, response.requestId, workerId, leaseId, response.ok ? "completed" : "failed", resultJson, Date.now())));
    console.info(JSON.stringify({ event: "tool_rpc.command.settled", tenantId, runId: response.runId, requestId: response.requestId, state: response.ok ? "completed" : "failed", ok }));
    if (ok) this.resolve(response);
    return ok;
  }

  poll(runId: string): ToolRequest | null {
    const queue = this.queues.get(runId);
    const request = queue?.shift() ?? null;
    if (request) this.inFlight.add(request.requestId);
    return request;
  }

  resolve(response: ToolResponse): boolean {
    const pending = this.pending.get(response.requestId);
    if (!pending || pending.request.runId !== response.runId) return false;
    this.pending.delete(response.requestId);
    this.inFlight.delete(response.requestId);
    clearTimeout(pending.timer);
    pending.resolve(response);
    return true;
  }

  async cancelRun(runId: string, tenantId?: string): Promise<void> {
    if (tenantId) {
      const store = await this.store(tenantId);
      if (store) await value(store.failPendingToolRpc(tenantId, runId, "Cancelled by user", Date.now()));
    }
    this.finish(runId, "Cancelled by user");
  }

  async failRun(runId: string, reason: string, tenantId?: string): Promise<void> {
    if (tenantId) {
      const store = await this.store(tenantId);
      if (store) await value(store.failPendingToolRpc(tenantId, runId, reason, Date.now()));
    }
    this.finish(runId, reason);
  }

  failInFlight(runId: string, reason: string): number {
    let count = 0;
    for (const [id, pending] of [...this.pending]) {
      if (pending.request.runId !== runId || !this.inFlight.has(id)) continue;
      clearTimeout(pending.timer);
      this.pending.delete(id);
      this.inFlight.delete(id);
      pending.resolve({ requestId: id, runId, ok: false, error: reason, durationMs: Date.now() - pending.request.createdAt });
      count++;
    }
    return count;
  }

  async markInFlightUncertain(runId: string, tenantId: string, reason: string): Promise<void> {
    const store = await this.store(tenantId);
    if (!store) throw new Error("Durable ToolRpc storage unavailable");
    await value(store.markToolRpcRunUncertain(tenantId, runId, reason, Date.now()));
    console.info(JSON.stringify({ event: "tool_rpc.command.recovery_uncertain", tenantId, runId }));
  }

  async cleanup(runId: string, tenantId?: string): Promise<void> {
    await this.failRun(runId, "The run has ended; this tool request was never executed.", tenantId);
    this.queues.delete(runId);
  }

  private finish(runId: string, reason: string): void {
    this.finishQueued(runId, reason);
    this.queues.delete(runId);
  }

  private finishQueued(runId: string, reason: string): number {
    let count = 0;
    for (const [id, pending] of [...this.pending]) {
      if (pending.request.runId !== runId) continue;
      clearTimeout(pending.timer);
      this.pending.delete(id);
      this.inFlight.delete(id);
      pending.resolve({ requestId: id, runId, ok: false, error: reason, durationMs: Date.now() - pending.request.createdAt });
      count++;
    }
    return count;
  }
}

export const toolRpc = new ToolRpcChannel();
