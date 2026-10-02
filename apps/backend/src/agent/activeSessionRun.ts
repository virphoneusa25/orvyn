export interface ActiveRunCandidate { id: string; status: string }

const ACTIVE_STATUSES = new Set(["running", "queued", "awaiting_approval"]);

/** Only serialize runs within the same conversation; other chats keep working. */
export function activeRunForSession<T extends ActiveRunCandidate>(
  runs: readonly T[],
  sessionId: string | null | undefined,
  sessionOfRun: (runId: string) => { sessionId?: string | null } | undefined,
): T | undefined {
  if (!sessionId) return undefined;
  return runs.find((run) => ACTIVE_STATUSES.has(run.status) && sessionOfRun(run.id)?.sessionId === sessionId);
}
