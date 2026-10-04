// apps/backend/src/queue/RedisRunEventBridge.ts
//
// API-side bridge: consumes worker event envelopes from Redis Streams and
// re-emits them through the existing RunStore. RunStore remains the canonical
// sequence allocator, durable JSONL writer, and SSE fan-out source.

import type { RunStore } from "../agent/events";
import { isTerminal } from "../agent/events";
import type { RedisRunEventTransport } from "./RedisRunEventTransport";

export class RedisRunEventBridge {
  private stopped = false;
  private cursor = "0-0";

  constructor(
    private readonly runId: string,
    private readonly store: RunStore,
    private readonly transport: RedisRunEventTransport
  ) {}

  stop(): void {
    this.stopped = true;
  }

  async run(): Promise<void> {
    while (!this.stopped) {
      const run = this.store.get(this.runId);
      if (!run || isTerminal(run.status)) return;

      const records = await this.transport.readAfter(this.runId, this.cursor, 2000, 200);
      if (!records.length) continue;

      for (const record of records) {
        this.cursor = record.redisId;
        const event = record.event;
        if (event.runId !== this.runId) continue;

        this.store.emit(this.runId, event.type, event.data);

        if (event.type === "run.queued") this.store.setStatus(this.runId, "queued");
        if (event.type === "run.started") this.store.setStatus(this.runId, "running");
        if (event.type === "approval.required") this.store.setStatus(this.runId, "awaiting_approval");
        if (event.type === "approval.resolved") this.store.setStatus(this.runId, "running");

        if (event.type === "run.completed") {
          this.store.setStatus(this.runId, "completed");
          return;
        }
        if (event.type === "run.error") {
          this.store.setStatus(this.runId, "error");
          return;
        }
        if (event.type === "run.cancelled") {
          this.store.setStatus(this.runId, "cancelled");
          return;
        }
      }
    }
  }
}
