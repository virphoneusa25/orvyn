// apps/backend/src/execution/ToolRpc.ts
//
// The tool RPC channel: control-plane ↔ worker request/response for
// remote tool execution. The ORION runtime stays in the control plane
// (model credentials NEVER reach workers/containers); tool calls are
// routed through this channel to the worker which executes them inside
// the mission container.
//
// Architecture:
//   ORION → ToolGateway → RemoteToolAdapter → ToolRpcChannel → Worker
//   Worker → container exec → result → ToolRpcChannel → ORION
//
// Uses HTTP long-poll + result endpoint (the spec's acceptable option).

import { randomUUID } from "crypto";

export interface ToolRequest {
  requestId: string;
  runId: string;
  tool: string;
  arguments: Record<string, unknown>;
  timeoutMs: number;
  createdAt: number;
}

export interface ToolResponse {
  requestId: string;
  runId: string;
  ok: boolean;
  output?: string;
  stderr?: string;
  exitCode?: number;
  error?: string;
  durationMs: number;
}

type PendingRequest = {
  request: ToolRequest;
  resolve: (response: ToolResponse) => void;
  timer: NodeJS.Timeout;
};

/**
 * In-memory tool request queue per run. The worker polls for the next
 * tool request, executes it in the container, and POSTs the result.
 * The pending Promise resolves (or times out).
 */
export class ToolRpcChannel {
  private queues = new Map<string, ToolRequest[]>(); // runId → pending requests
  private pending = new Map<string, PendingRequest>(); // requestId → pending promise

  /**
   * Sends a tool request to the worker for a run. Returns the result.
   * Times out after the specified duration.
   */
  execute(
    runId: string,
    tool: string,
    args: Record<string, unknown>,
    timeoutMs = 60_000
  ): Promise<ToolResponse> {
    const request: ToolRequest = {
      requestId: randomUUID(),
      runId,
      tool,
      arguments: args,
      timeoutMs,
      createdAt: Date.now(),
    };

    return new Promise<ToolResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(request.requestId);
        reject(new Error(`Remote tool "${tool}" timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pending.set(request.requestId, { request, resolve, timer });

      const queue = this.queues.get(runId) ?? [];
      queue.push(request);
      this.queues.set(runId, queue);
    });
  }

  /** Worker calls this to get the next tool request for a run. */
  poll(runId: string): ToolRequest | null {
    const queue = this.queues.get(runId);
    if (!queue || queue.length === 0) return null;
    return queue.shift() ?? null;
  }

  /** Worker calls this with the result. Resolves the pending Promise. */
  resolve(response: ToolResponse): boolean {
    const pending = this.pending.get(response.requestId);
    if (!pending) return false;
    this.pending.delete(response.requestId);
    clearTimeout(pending.timer);
    pending.resolve(response);
    return true;
  }

  /** Cancel all pending requests for a run (Stop button) — including ones
   *  already polled by the worker (in flight) and ones still queued. */
  cancelRun(runId: string): void {
    const queued = new Set((this.queues.get(runId) ?? []).map((r) => r.requestId));
    for (const [requestId, pending] of [...this.pending]) {
      if (pending.request.runId !== runId && !queued.has(requestId)) continue;
      clearTimeout(pending.timer);
      this.pending.delete(requestId);
      pending.resolve({
        requestId,
        runId,
        ok: false,
        error: "Cancelled by user",
        durationMs: 0,
      });
    }
    this.queues.delete(runId);
  }

  /**
   * Fails every pending request for a run with a truthful reason (the worker
   * stopped the container, the run ended). The awaiting tool call surfaces
   * the error to the model immediately instead of burning its full timeout.
   */
  failRun(runId: string, reason: string): void {
    const queued = new Set((this.queues.get(runId) ?? []).map((r) => r.requestId));
    for (const [requestId, pending] of [...this.pending]) {
      if (pending.request.runId !== runId && !queued.has(requestId)) continue;
      clearTimeout(pending.timer);
      this.pending.delete(requestId);
      pending.resolve({
        requestId,
        runId,
        ok: false,
        error: reason,
        durationMs: Date.now() - pending.request.createdAt,
      });
    }
    this.queues.delete(runId);
  }

  /** Clean up a completed run: pending requests resolve as finished (they
   *  can never be served) and the queue is dropped. */
  cleanup(runId: string): void {
    this.failRun(runId, "The run has ended; this tool request was never executed.");
    this.queues.delete(runId);
  }
}

// Singleton — one channel per backend process
export const toolRpc = new ToolRpcChannel();
