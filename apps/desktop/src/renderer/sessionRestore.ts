// Reconnect one desktop chat to its backend WorkSession.
// The session record is authoritative; the local chat file is only a cache.

import { completeSessionRestore, failSessionRestore, sessionRestoreState, type CanonicalWorkSession } from "./chatSession.ts";

export interface SessionGet {
  (path: string): Promise<{ ok: boolean; body: unknown }>;
}

interface SessionRecord {
  sessionId?: string;
  projectId?: string | null;
  workspaceId?: string | null;
  projectRoot?: string | null;
  runIds?: string[];
  activeRunId?: string | null;
}

/**
 * Fetch the session, then its messages. Both must succeed before the local
 * cache is replaced and another agent run is allowed.
 */
export async function restoreWorkSessionFromBackend(opts: {
  sessionId: string;
  chatId: string;
  gen: number;
  get: SessionGet;
}): Promise<"ready" | "failed"> {
  const { sessionId, chatId, gen, get } = opts;
  try {
    const [sessionRes, messageRes, stateRes] = await Promise.all([
      get(`/sessions/${encodeURIComponent(sessionId)}`),
      get(`/sessions/${encodeURIComponent(sessionId)}/messages`),
      get(`/sessions/${encodeURIComponent(sessionId)}/state`),
    ]);
    const session = sessionRes.ok ? (sessionRes.body as { session?: SessionRecord } | null)?.session : null;
    const messagesOk = messageRes.ok && Array.isArray((messageRes.body as { messages?: unknown } | null)?.messages);
    if (!session?.sessionId || !messagesOk) {
      failSessionRestore(chatId, gen);
      return "failed";
    }
    const stateBody = stateRes.ok ? stateRes.body as { files?: CanonicalWorkSession["files"]; preview?: { url?: string; available?: boolean } | null } : null;
    const canonical: CanonicalWorkSession = {
      sessionId: session.sessionId,
      projectId: session.projectId ?? null,
      workspaceId: session.workspaceId ?? null,
      projectRoot: session.projectRoot ?? null,
      runIds: session.runIds ?? [],
      activeRunId: session.activeRunId ?? null,
      files: stateBody?.files,
      preview: stateBody?.preview?.url ? { url: stateBody.preview.url, available: stateBody.preview.available } : null,
    };
    const applied = completeSessionRestore(chatId, gen, canonical);
    if (applied) return "ready";
    return sessionRestoreState(chatId) === "ready" ? "ready" : "failed";
  } catch {
    failSessionRestore(chatId, gen);
    return "failed";
  }
}
