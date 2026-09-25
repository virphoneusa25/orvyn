// The earlier runs of the WorkSession the attached run belongs to.
//
// Every follow-up message starts a new run in the same durable backend
// session. The stream shows the whole session, oldest first, instead of only
// the newest run.

import { useEffect, useRef, useState } from "react";
import { apiUrl, authHeaders } from "./connection";
import type { AgentEvent } from "./components/AgentActivityList";
import type { ThreadRunView } from "./streamOrder";
import { getActiveChat } from "./chatSession";

interface ThreadRunSummary { runId: string; status: string; createdAt: number; instruction: string }

/** The session a run belongs to: its run.session marker, else the chat that owns the run. */
export function sessionIdFor(runId: string | null, events: { type: string; data?: Record<string, unknown> }[], chatSessionId?: string | null): string | null {
  if (!runId) return null;
  const marker = events.find((e) => e.type === "run.session");
  if (marker?.data?.sessionId) return String(marker.data.sessionId);
  return chatSessionId ?? null;
}

export function useRunThread(runId: string | null, events: AgentEvent[]): { earlier: ThreadRunView<AgentEvent>[]; currentInstruction?: string; newestRunId?: string } {
  const chat = getActiveChat();
  const chatSessionId = chat && runId && (chat.runId === runId || chat.runIds?.includes(runId)) ? chat.sessionId ?? null : null;
  const threadId = sessionIdFor(runId, events, chatSessionId);
  const [earlier, setEarlier] = useState<ThreadRunView<AgentEvent>[]>([]);
  const [newestRunId, setNewestRunId] = useState<string | undefined>(undefined);
  const cache = useRef(new Map<string, { status: string; events: AgentEvent[] }>());

  useEffect(() => {
    if (!runId || !threadId) { setEarlier([]); return; }
    let alive = true;
    (async () => {
      try {
        const res = await fetch(apiUrl(`/sessions/${encodeURIComponent(threadId)}`), { headers: authHeaders() });
        if (!res.ok) { if (alive) setEarlier([]); return; }
        const body = (await res.json()) as { runs?: ThreadRunSummary[] };
        // The session lists its runs oldest first.
        const all = body.runs ?? [];
        const at = all.findIndex((r) => r.runId === runId);
        const before = (at >= 0 ? all.slice(0, at) : all.filter((r) => r.runId !== runId)).filter((r) => r.status !== "unavailable");
        // Reopened from history on an older run: the conversation continues further.
        const newest = all[all.length - 1];
        if (alive) setNewestRunId(newest && newest.runId !== runId ? newest.runId : undefined);
        const views: ThreadRunView<AgentEvent>[] = [];
        for (const r of before) {
          let got = cache.current.get(r.runId);
          // Finished runs never change: fetch their events once.
          if (!got || got.status !== r.status) {
            const er = await fetch(apiUrl(`/agent/stream/runs/${encodeURIComponent(r.runId)}/events.json`), { headers: authHeaders() });
            const data = er.ok ? ((await er.json()) as { status?: string; events?: AgentEvent[] }) : {};
            got = { status: data.status ?? r.status, events: data.events ?? [] };
            cache.current.set(r.runId, got);
          }
          views.push({ runId: r.runId, createdAt: r.createdAt, instruction: r.instruction, status: got.status, events: got.events });
        }
        if (alive) setEarlier(views);
      } catch {
        if (alive) setEarlier([]);
      }
    })();
    return () => { alive = false; };
  }, [runId, threadId]);

  const started = events.find((e) => e.type === "run.started");
  return { earlier, currentInstruction: started ? String(started.data?.instruction ?? "") : undefined, newestRunId };
}
