// apps/backend/src/queue/RedisRunEventTransport.ts
//
// Cross-process event fabric for distributed missions.
//
// Workers publish event envelopes WITHOUT AgentEvent.sequence. The API remains
// the sole canonical sequence allocator by feeding envelopes into RunStore.emit().
// This prevents two processes from generating conflicting SSE resume cursors.

import type { Redis } from "ioredis";
import type { AgentEventType } from "../agent/events";
import { MISSION_EVENT_STREAM_PREFIX } from "./types";

function streamKey(runId: string): string {
  return `${MISSION_EVENT_STREAM_PREFIX}${runId}`;
}

export interface DistributedRunEvent {
  runId: string;
  type: AgentEventType;
  timestamp: number;
  data: Record<string, unknown>;
}

export interface StreamRecord {
  redisId: string;
  event: DistributedRunEvent;
}

export class RedisRunEventTransport {
  constructor(private readonly redis: Redis) {}

  async publish(event: DistributedRunEvent): Promise<string> {
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

    const result = (await (this.redis as any).xread(...args)) as
      | Array<[string, Array<[string, string[]]>]>
      | null;

    if (!result?.length) return [];
    const [, rows] = result[0];
    const out: StreamRecord[] = [];

    for (const [redisId, fields] of rows) {
      for (let i = 0; i < fields.length - 1; i += 2) {
        if (fields[i] !== "event") continue;
        try {
          const parsed = JSON.parse(fields[i + 1]) as DistributedRunEvent;
          if (!parsed?.runId || !parsed?.type || typeof parsed.timestamp !== "number") continue;
          out.push({ redisId, event: parsed });
        } catch {
          // One malformed transport record must not poison a reconnecting stream.
        }
      }
    }
    return out;
  }

  async close(): Promise<void> {
    await this.redis.quit();
  }
}
