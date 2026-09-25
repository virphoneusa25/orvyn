// The backend's durable WorkSessions (authoritative for conversations).
import { apiUrl, authHeaders } from "./connection";
import { initChatHistory, mergeBackendSessions, setSessionMirror, type BackendSessionLike } from "./chatSession";

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

// Renames, pins, archives and deletes in the chat list reach the backend session.
setSessionMirror({ patch: (id, p) => void patchSession(id, p), remove: (id) => void deleteSession(id) });
