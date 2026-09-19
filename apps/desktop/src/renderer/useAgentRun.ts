import { useCallback, useEffect, useRef, useState } from "react";
import { apiUrl, authHeaders, getConnectionConfig } from "./connection";
import { AgentEvent } from "./components/AgentActivityList";
import { Attachment } from "./components/AttachmentBar";

export interface RunUsage {
  promptTokens: number;
  completionTokens: number;
  turns: number;
  contextTokens: number;
  contextBudget: number;
  modelId?: string;
}

/** A run is over when no further events can arrive for it. */
export function isRunFinished(status: string): boolean {
  return status === "completed" || status === "error" || status === "cancelled";
}

export function useAgentRun(
  projectRoot: string | null,
  opts?: { attachRunId?: string | null }
) {
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [status, setStatus] = useState<string>("idle");
  const [runId, setRunId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [usage, setUsage] = useState<RunUsage | null>(null);
  const [availableTools, setAvailableTools] = useState<{ name: string; permission: string }[]>([]);
  const lastSeq = useRef(0);
  const streamRef = useRef<EventSource | null>(null);
  const modeRef = useRef("agent");
  // Read inside poll(), which is a stable callback and would otherwise close
  // over a stale runId from the render that created it.
  const runIdRef = useRef<string | null>(null);

  // Attach to a run started elsewhere (Home composer, quick actions) so the
  // Build tab follows active work instead of only runs it started itself.
  useEffect(() => {
    const id = opts?.attachRunId ?? null;
    if (id === runIdRef.current) return;
    if (!id) {
      // Cleared (New Task / fresh conversation): drop the previous run's
      // events so a fresh workspace doesn't show stale activity.
      setEvents([]);
      setError(null);
      setUsage(null);
      lastSeq.current = 0;
      setRunId(null);
      runIdRef.current = null;
      setStatus("idle");
      streamRef.current?.close();
      return;
    }
    setEvents([]);
    setError(null);
    setUsage(null);
    lastSeq.current = 0;
    setRunId(id);
    runIdRef.current = id;
    modeRef.current = "multitask";
    setStatus("running");
    attachStream(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opts?.attachRunId]);

  useEffect(() => {
    if (!projectRoot) {
      setAvailableTools([]);
      return;
    }
    fetch(apiUrl(`/tools?projectRoot=${encodeURIComponent(projectRoot)}`), { headers: authHeaders() })
      .then((r) => r.json())
      .then((data) => setAvailableTools(data.tools ?? []))
      .catch(() => setAvailableTools([]));
  }, [projectRoot, status]);

  useEffect(() => {
    return () => {
      streamRef.current?.close();
    };
  }, []);

  function eventUrl(id: string): string {
    const cfg = getConnectionConfig();
    const after = lastSeq.current;
    const token = cfg.apiKey ? `&token=${encodeURIComponent(cfg.apiKey)}` : "";
    return apiUrl(`/agent/stream/runs/${id}/events?after=${after}${token}`);
  }

  function applyEvent(e: AgentEvent) {
    lastSeq.current = Math.max(lastSeq.current, e.sequence);
    setEvents((prev) => (prev.some((x) => x.id === e.id) ? prev : [...prev, e]));
    if (e.type === "approval.required") setStatus("awaiting_approval");
    else if (e.type === "run.queued") setStatus("queued");
    else if (e.type === "run.started") setStatus("running");
    else if (e.type === "run.completed") {
      setStatus("completed");
      streamRef.current?.close();
    } else if (e.type === "run.error") {
      setStatus("error");
      streamRef.current?.close();
    } else if (e.type === "run.cancelled") {
      setStatus("cancelled");
      streamRef.current?.close();
    } else if (e.type === "approval.resolved") setStatus("running");
    else if (e.type === "usage.updated") {
      setUsage({
        promptTokens: Number(e.data.promptTokens ?? 0),
        completionTokens: Number(e.data.completionTokens ?? 0),
        turns: Number(e.data.turns ?? 0),
        contextTokens: Number(e.data.contextTokens ?? 0),
        contextBudget: Number(e.data.contextBudget ?? 0),
        modelId: e.data.modelId ? String(e.data.modelId) : undefined,
      });
    }
  }

  function attachStream(id: string) {
    streamRef.current?.close();
    const es = new EventSource(eventUrl(id));
    streamRef.current = es;
    es.onmessage = (ev) => {
      try {
        applyEvent(JSON.parse(ev.data));
      } catch {
        // skip malformed
      }
    };
    es.onerror = () => {
      if (es.readyState === EventSource.CLOSED) return;
      es.close();
      streamRef.current = null;
      void poll(id);
    };
  }

  const poll = useCallback(async (id: string) => {
    try {
      const res = await fetch(apiUrl(`/agent/stream/runs/${id}/events.json?after=${lastSeq.current}`), {
        headers: authHeaders(),
      });
      if (!res.ok) return;
      const data = await res.json();
      if (data.events?.length) {
        for (const e of data.events) applyEvent(e);
      }
      setStatus(data.status);
      if (data.status === "running" || data.status === "awaiting_approval" || data.status === "queued") {
        setTimeout(() => poll(id), 80);
      }
    } catch {
      // Give up once the run is no longer this hook's current run, otherwise a
      // failing poll loop outlives the run forever.
      if (runIdRef.current === id) setTimeout(() => poll(id), 400);
    }
  }, []);

  async function start(opts: {
    instruction: string;
    mode?: string;
    attachments?: Attachment[];
  }): Promise<boolean> {
    if (!projectRoot || !opts.instruction.trim()) return false;
    const mode = opts.mode ?? "agent";
    modeRef.current = mode;
    setEvents([]);
    setError(null);
    setUsage(null);
    lastSeq.current = 0;
    try {
      const endpoint = mode === "multitask" ? "/agent/orchestrate" : "/agent/stream/runs";
      const payload =
        mode === "multitask"
          ? { projectRoot, goal: opts.instruction, attachments: opts.attachments }
          : { projectRoot, instruction: opts.instruction, mode, attachments: opts.attachments };
      const res = await fetch(apiUrl(endpoint), {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to start run");
      setRunId(data.runId);
      runIdRef.current = data.runId;
      setStatus("running");
      attachStream(data.runId);
      return true;
    } catch (err: any) {
      setError(err.message);
      return false;
    }
  }

  /**
   * Stops the run. The status flips immediately so the button responds, but
   * the authoritative `run.cancelled` event still arrives over the stream —
   * the server decides when the run is really over.
   */
  async function stop(): Promise<void> {
    const id = runIdRef.current;
    if (!id || isRunFinished(status)) return;
    setStatus("cancelling");
    try {
      const res = await fetch(apiUrl(`/agent/stream/runs/${id}/cancel`), {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Failed to stop run");
    } catch (err: any) {
      // Surface it and restore the status: a Stop that silently did nothing is
      // worse than one that admits it failed.
      setError(err.message);
      setStatus("running");
    }
  }

  async function approve(callId: string, approved: boolean, scope: "once" | "mission" = "once") {
    const approvalPath =
      modeRef.current === "multitask"
        ? `/agent/orchestrate/approvals/${callId}`
        : `/agent/stream/approvals/${callId}`;
    await fetch(apiUrl(approvalPath), {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ approved, scope }),
    });
    if (runId) attachStream(runId);
  }

  return {
    events,
    status,
    runId,
    error,
    usage,
    availableTools,
    lastSeq: lastSeq.current,
    start,
    stop,
    approve,
  };
}
