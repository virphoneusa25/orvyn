// apps/backend/src/queue/RunControlPublisher.ts
//
// Small API-facing helper that converts the current ORVYN controls into
// serializable Redis Stream commands. Authorization stays in the HTTP layer.

import { randomUUID } from "crypto";
import type { RedisRunControlTransport } from "./RedisRunControlTransport";
import type { ApprovalScope, RunControlCommand } from "./controlTypes";

export class RunControlPublisher {
  constructor(private readonly transport: RedisRunControlTransport) {}

  async cancel(runId: string, tenantId: string): Promise<string> {
    return this.send({
      id: randomUUID(),
      type: "cancel",
      runId,
      tenantId,
      requestedAt: Date.now(),
    });
  }

  async steer(runId: string, tenantId: string, text: string): Promise<string> {
    const trimmed = text.trim();
    if (!trimmed) throw new Error("Steering text is required");
    return this.send({
      id: randomUUID(),
      type: "steer",
      runId,
      tenantId,
      text: trimmed,
      requestedAt: Date.now(),
    });
  }

  async approval(
    runId: string,
    tenantId: string,
    callId: string,
    approved: boolean,
    scope: ApprovalScope
  ): Promise<string> {
    if (!callId) throw new Error("callId is required");
    return this.send({
      id: randomUUID(),
      type: "approval",
      runId,
      tenantId,
      callId,
      approved,
      scope,
      requestedAt: Date.now(),
    });
  }

  private async send(command: RunControlCommand): Promise<string> {
    return this.transport.publish(command);
  }
}
