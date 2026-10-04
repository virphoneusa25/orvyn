// apps/backend/src/queue/RedisRunEventTransport.ts
//
// Cross-process event fabric for distributed missions. Redis Stream IDs are
// transport cursors; AgentEvent.sequence remains the UI's stable per-run order.

import type { Redis } from "ioredis";
import type { AgentEvent } from "../agent/events";
import { MISSION_EVENT_STREAM_PREFIX } from "./types";

function streamKey(runId: string): string {
  return `${MISSION_EVENT_STREAM_PREFIX}${runId}`;
}

export interface StreamRecord {
  redisId: string;
  event: AgentEvent;
}

export class RedisRunEventTransport {
  constructor(private readonly redis: Redis) {}

  async publish(event: AgentEvent): Promise<string> {
    const id = await this.redis.xadd(
      streamKey(event.runId),
      "MAXLEN",
      "~",
      "10000",
      "*",
      "event",
      JSON.stringify(event)
    );
    if (!id) throw new Error("Redis did not return a stream id");
    return id;
  }

  async readAfter(runId: string, afterId = "0-0", blockMs = 0, count = 200): Promise<StreamRecord[]> {
    const args: Array<string | number> = ["COUNT", count];
    if (blockMs > 0) args.push("BLOCK", blockMs);
    args.push("STREAMS", streamKey(runId), afterId);

    const result = (await this.redis.xread(...(args as [any, ...any[]]))) as
      | Array<[string, Array<[string, string[]]>]>
      | null;

    if (!result?.length) return [];
    const [, rows] = result[0];
    const out: StreamRecord[] = [];

    for (const [redisId, fields] of rows) {
      for (let i = 0; i < fields.length - 1; i += 2) {
        if (fields[i] !== "event") continue;
        try {
          out.push({ redisId, event: JSON.parse(fields[i + 1]) as AgentEvent });
        } catch {
          // Bad transport records are skipped; one malformed event must not
          // poison a reconnecting stream.
        }
      }
    }
    return out;
  }

  async close(): Promise<void> {
    await this.redis.quit();
  }
}
