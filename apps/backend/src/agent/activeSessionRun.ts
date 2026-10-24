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

/** Database-backed session ownership is resolved before admitting another run. */
export async function activeRunForSessionAsync<T extends ActiveRunCandidate>(
  runs: readonly T[], sessionId: string | null | undefined,
  sessionOfRun: (runId: string) => {sessionId?: string | null} | undefined | Promise<{sessionId?: string | null} | undefined>,
): Promise<T | undefined> {
  if (!sessionId) return undefined;
  for (const run of runs) if (ACTIVE_STATUSES.has(run.status) && (await sessionOfRun(run.id))?.sessionId === sessionId) return run;
  return undefined;
}
