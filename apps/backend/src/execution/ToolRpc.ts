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

  /** Cancel all pending requests for a run (Stop button). */
  cancelRun(runId: string): void {
    const queue = this.queues.get(runId);
    if (queue) {
      for (const req of queue) {
        const pending = this.pending.get(req.requestId);
        if (pending) {
          clearTimeout(pending.timer);
          pending.resolve({
            requestId: req.requestId,
            runId,
            ok: false,
            error: "Cancelled by user",
            durationMs: 0,
          });
          this.pending.delete(req.requestId);
        }
      }
      this.queues.delete(runId);
    }
  }

  /** Clean up a completed run. */
  cleanup(runId: string): void {
    this.cancelRun(runId);
    this.queues.delete(runId);
  }
}

// Singleton — one channel per backend process
export const toolRpc = new ToolRpcChannel();
