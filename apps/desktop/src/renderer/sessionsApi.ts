// The backend's durable WorkSessions (authoritative for conversations).
import { apiUrl, authHeaders } from "./connection";
import { applyBackendMessages, getActiveChat, initChatHistory, mergeBackendSessions, setSessionMirror, type BackendMessageLike, type BackendSessionLike } from "./chatSession";

export async function fetchSessions(): Promise<BackendSessionLike[]> {
  const res = await fetch(apiUrl("/sessions"), { headers: authHeaders() });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = (await res.json()) as { sessions?: BackendSessionLike[] };
  return body.sessions ?? [];
}

/** Loads the backend's sessions into the chat list. Offline: the cache stays as it is. */
export async function syncSessions(): Promise<number> {
  try {
    // Merge into the loaded cache, never into an empty list that the disk load then overwrites.
    await initChatHistory();
    const list = await fetchSessions();
    mergeBackendSessions(list);
    // The open conversation: its messages from the backend.
    const open = getActiveChat()?.sessionId;
    if (open) await loadSessionMessages(open);
    return list.length;
  } catch {
    return -1;
  }
}

export async function createSession(title: string, projectRoot?: string | null): Promise<BackendSessionLike | null> {
  try {
    const res = await fetch(apiUrl("/sessions"), {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ title, projectRoot: projectRoot ?? null }),
    });
    if (!res.ok) return null;
    return ((await res.json()) as { session: BackendSessionLike }).session;
  } catch {
    return null;
  }
}

export async function patchSession(sessionId: string, patch: { title?: string; status?: string; pinned?: boolean }): Promise<void> {
  await fetch(apiUrl(`/sessions/${encodeURIComponent(sessionId)}`), {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(patch),
  }).catch(() => undefined);
}

export async function deleteSession(sessionId: string): Promise<void> {
  await fetch(apiUrl(`/sessions/${encodeURIComponent(sessionId)}`), { method: "DELETE", headers: authHeaders() }).catch(() => undefined);
}

export interface SessionStateView {
  session: BackendSessionLike & { workspaceId: string | null; projectId: string | null };
  runs: { runId: string; status: string; createdAt: number; instruction: string }[];
  activeRunId: string | null;
  messageCount: number;
  files: { path: string; operation: string; runId: string; at: number }[];
  artifacts: { artifactId: string; name: string; mimeType?: string; runId: string; at: number }[];
  preview: { url: string; runId: string; at: number; available: boolean } | null;
}

/** Everything the session produced: project, runs, changed files, artifacts, newest preview. */
export async function fetchSessionState(sessionId: string): Promise<SessionStateView | null> {
  try {
    const res = await fetch(apiUrl(`/sessions/${encodeURIComponent(sessionId)}/state`), { headers: authHeaders() });
    return res.ok ? ((await res.json()) as SessionStateView) : null;
  } catch {
    return null;
  }
}

/** Same folder, whatever the case or slashes (Windows paths). */
export function sameRoot(a: string | null | undefined, b: string | null | undefined): boolean {
  const norm = (p: string) => { const r = p.trim().replace(/\\/g, "/").replace(/\/+$/, ""); return /^[A-Za-z]:\//.test(r) ? r.toLowerCase() : r; };
  return Boolean(a && b) && norm(a!) === norm(b!);
}

/** A session's messages, in order, merged into its chat. */
export async function loadSessionMessages(sessionId: string): Promise<number> {
  try {
    const res = await fetch(apiUrl(`/sessions/${encodeURIComponent(sessionId)}/messages`), { headers: authHeaders() });
    if (!res.ok) return -1;
    const body = (await res.json()) as { messages?: BackendMessageLike[] };
    applyBackendMessages(sessionId, body.messages ?? []);
    return body.messages?.length ?? 0;
  } catch {
    return -1;
  }
}

// Renames, pins, archives and deletes in the chat list reach the backend
// session; opening a chat loads its messages from it.
setSessionMirror({
  patch: (id, p) => void patchSession(id, p),
  remove: (id) => void deleteSession(id),
  load: (id) => void loadSessionMessages(id),
});
