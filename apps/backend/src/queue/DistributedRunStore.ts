// apps/backend/src/queue/DistributedRunStore.ts
//
// Worker-side RunStore that keeps the existing MultiAgentRuntime contract
// intact while forwarding every emitted event to the API over Redis Streams.
//
// It deliberately has no disk directory: the API remains the sole durable
// RunStore/SSE sequence authority. The worker keeps only the live run state
// needed by MultiAgentRuntime (status, steering queue, approvals, usage).

import { RunStore, AgentEvent, AgentEventType } from "../agent/events";
import type { RedisRunEventTransport } from "./RedisRunEventTransport";

export class DistributedRunStore extends RunStore {
  private publishes = new Set<Promise<unknown>>();

  constructor(private readonly transport: RedisRunEventTransport) {
    super();
  }

  override emit(
    runId: string,
    type: AgentEventType,
    data: Record<string, unknown> = {}
  ): AgentEvent | undefined {
    const local = super.emit(runId, type, data);
    if (!local) return undefined;

    const publish = this.transport
      .publish({
        runId,
        type,
        timestamp: local.timestamp,
        data,
      })
      .catch((err) => {
        // The runtime must fail truthfully at the worker boundary rather than
        // crashing synchronously inside an event callback.
        console.error(`[distributed-run-store] event publish failed for ${runId}: ${err?.message ?? err}`);
      })
      .finally(() => this.publishes.delete(publish));

    this.publishes.add(publish);
    return local;
  }

  /** Ensure all queued event writes reached Redis before a worker job returns. */
  async flush(): Promise<void> {
    while (this.publishes.size > 0) {
      await Promise.allSettled(Array.from(this.publishes));
    }
  }
}
