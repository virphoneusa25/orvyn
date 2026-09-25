// Composer runs live in RunStore. TaskEngine missions are a second list.
// Home and Mission Control only read /missions, so a composer run has to
// appear there or the user cannot reopen it.

export interface MissionListTask {
  id: string;
  description: string;
  agent: string;
  status: string;
  attempts: number;
}

export interface MissionListRow {
  id: string;
  runId: string;
  goal: string;
  status: string;
  reviewCycles: number;
  createdAt: number;
  updatedAt: number;
  tasks: MissionListTask[];
}

export function missionStatusForRun(status: string): string {
  if (status === "completed") return "COMPLETED";
  if (status === "error") return "FAILED";
  if (status === "cancelled") return "CANCELLED";
  if (status === "blocked") return "BLOCKED";
  if (status === "awaiting_approval") return "REVIEW";
  return "RUNNING";
}

export function goalFromRunEvents(events: { type: string; data?: Record<string, unknown> }[]): string {
  const started = events.find((e) => e.type === "run.started");
  const instruction = String(started?.data?.instruction ?? "").trim();
  return instruction.slice(0, 160) || "Untitled run";
}

export function composerRunsAsMissions(
  runs: { id: string; status: string; createdAt: number; events: { type: string; data?: Record<string, unknown> }[] }[],
  existingRunIds: Set<string>,
): MissionListRow[] {
  return runs
    .filter((r) => !existingRunIds.has(r.id))
    .map((r) => ({
      id: r.id,
      runId: r.id,
      goal: goalFromRunEvents(r.events),
      status: missionStatusForRun(r.status),
      reviewCycles: 0,
      createdAt: r.createdAt,
      updatedAt: r.createdAt,
      tasks: [],
    }));
}
