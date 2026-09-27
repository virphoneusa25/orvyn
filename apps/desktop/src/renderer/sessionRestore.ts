// Reconnect one desktop chat to its backend WorkSession.
// The session record is authoritative; the local chat file is only a cache.

import { completeSessionRestore, failSessionRestore, sessionRestoreState, type CanonicalWorkSession } from "./chatSession.ts";

export interface SessionGet {
  (path: string): Promise<{ ok: boolean; body: unknown }>;
}

interface SessionRecord {
  sessionId?: string;
  title?: string | null;
  projectId?: string | null;
  workspaceId?: string | null;
  projectRoot?: string | null;
  runIds?: string[];
  activeRunId?: string | null;
}

interface StateFile {
  path?: string;
  operation?: string;
  runId?: string;
  at?: number;
}

interface StateBody {
  session?: { title?: string | null; projectRoot?: string | null };
  runs?: { runId?: string; status?: string; instruction?: string; createdAt?: number }[];
  files?: StateFile[];
  artifacts?: { artifactId?: string; name?: string; mimeType?: string; runId?: string }[];
  preview?: { url?: string; available?: boolean; runId?: string } | null;
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
    const stateBody = stateRes.ok ? stateRes.body as StateBody | null : null;
    const files = (stateBody?.files ?? [])
      .filter((file): file is StateFile & { path: string } => Boolean(file?.path))
      .map((file) => ({ path: file.path, operation: file.operation || "write", runId: file.runId, at: file.at }));
    const runs = (stateBody?.runs ?? [])
      .filter((run) => Boolean(run?.runId))
      .map((run) => ({ runId: String(run.runId), status: String(run.status ?? ""), instruction: run.instruction, createdAt: run.createdAt }));
    const artifacts = (stateBody?.artifacts ?? [])
      .filter((item) => Boolean(item?.artifactId))
      .map((item) => ({ artifactId: String(item.artifactId), name: String(item.name ?? ""), mimeType: item.mimeType, runId: item.runId }));
    const title = stateBody?.session?.title || session.title || null;
    const canonical: CanonicalWorkSession = {
      sessionId: session.sessionId,
      projectId: session.projectId ?? null,
      workspaceId: session.workspaceId ?? null,
      projectRoot: session.projectRoot ?? null,
      projectName: title,
      runIds: session.runIds ?? [],
      activeRunId: session.activeRunId ?? null,
      files,
      runs,
      artifacts,
      preview: stateBody?.preview?.url
        ? { url: stateBody.preview.url, available: stateBody.preview.available, runId: stateBody.preview.runId }
        : null,
    };
    const applied = completeSessionRestore(chatId, gen, canonical);
    if (applied) return "ready";
    return sessionRestoreState(chatId) === "ready" ? "ready" : "failed";
  } catch {
    failSessionRestore(chatId, gen);
    return "failed";
  }
}
