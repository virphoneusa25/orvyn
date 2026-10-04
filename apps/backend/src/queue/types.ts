// apps/backend/src/queue/types.ts
import type { Attachment } from "@orvyn/ai-core";

export interface MissionJobPayload {
  runId: string;
  tenantId: string;
  tenantName: string;
  projectRoot: string;
  goal: string;
  rules?: string;
  attachments?: Attachment[];
  requestedAt: string;
}

export interface MissionQueueStats {
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
}

export const MISSION_QUEUE_NAME = "orvyn-missions";
export const MISSION_EVENT_STREAM_PREFIX = "orvyn:run-events:";
export const MISSION_CONTROL_STREAM_PREFIX = "orvyn:run-control:";
