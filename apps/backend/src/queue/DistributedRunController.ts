// apps/backend/src/queue/DistributedRunController.ts
//
// Worker-side consumer for API control commands. It translates the distributed
// transport back into the exact methods the existing MultiAgentRuntime already
// uses locally.

import type { MultiAgentRuntime } from "../agent/MultiAgentRuntime";
import type { RunStore } from "../agent/events";
import type { RedisRunControlTransport } from "./RedisRunControlTransport";

export class DistributedRunController {
  private stopped = false;
  private cursor = "0-0";

  constructor(
    private readonly runId: string,
    private readonly tenantId: string,
    private readonly runtime: MultiAgentRuntime,
    private readonly store: RunStore,
    private readonly transport: RedisRunControlTransport
  ) {}

  stop(): void {
    this.stopped = true;
  }

  async run(): Promise<void> {
    while (!this.stopped) {
      let records;
      try {
        records = await this.transport.readAfter(this.runId, this.cursor, 2000, 100);
      } catch (err) {
        if (this.stopped) return;
        console.error("[distributed-control] read failed", err);
        continue;
      }

      for (const record of records) {
        this.cursor = record.redisId;
        const command = record.command;
        if (command.runId !== this.runId || command.tenantId !== this.tenantId) continue;

        if (command.type === "cancel") {
          this.runtime.cancel(this.runId);
          continue;
        }

        if (command.type === "steer") {
          this.store.steer(this.runId, command.text);
          continue;
        }

        if (command.type === "approval") {
          const resolved = this.runtime.resolveApproval(
            command.callId,
            command.approved,
            command.scope
          );
          if (!resolved) {
            // Approval commands should only be emitted after the API received
            // approval.required from this worker. Log a race rather than
            // silently pretending the approval succeeded.
            console.warn(
              `[distributed-control] approval ${command.callId} arrived with no pending call for ${this.runId}`
            );
          }
        }
      }
    }
  }
}
