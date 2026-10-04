// apps/backend/src/queue/RedisRunControlTransport.ts

import type { Redis } from "ioredis";
import { MISSION_CONTROL_STREAM_PREFIX } from "./types";
import type { RunControlCommand } from "./controlTypes";

function streamKey(runId: string): string {
  return `${MISSION_CONTROL_STREAM_PREFIX}${runId}`;
}

export interface ControlStreamRecord {
  redisId: string;
  command: RunControlCommand;
}

export class RedisRunControlTransport {
  constructor(private readonly redis: Redis) {}

  async publish(command: RunControlCommand): Promise<string> {
    if (!command.runId || !command.tenantId || !command.id) {
      throw new Error("Invalid distributed run control command");
    }
    const id = await this.redis.xadd(
      streamKey(command.runId),
      "MAXLEN",
      "~",
      "2000",
      "*",
      "command",
      JSON.stringify(command)
    );
    if (!id) throw new Error("Redis did not return a control stream id");
    return id;
  }

  async readAfter(runId: string, afterId = "0-0", blockMs = 0, count = 100): Promise<ControlStreamRecord[]> {
    const args: Array<string | number> = ["COUNT", count];
    if (blockMs > 0) args.push("BLOCK", blockMs);
    args.push("STREAMS", streamKey(runId), afterId);

    const result = (await (this.redis as any).xread(...args)) as
      | Array<[string, Array<[string, string[]]>]>
      | null;

    if (!result?.length) return [];
    const [, rows] = result[0];
    const out: ControlStreamRecord[] = [];

    for (const [redisId, fields] of rows) {
      for (let i = 0; i < fields.length - 1; i += 2) {
        if (fields[i] !== "command") continue;
        try {
          const command = JSON.parse(fields[i + 1]) as RunControlCommand;
          if (!command?.id || !command?.runId || !command?.tenantId || !command?.type) continue;
          out.push({ redisId, command });
        } catch {
          // Skip malformed commands rather than killing the worker control loop.
        }
      }
    }
    return out;
  }
}
