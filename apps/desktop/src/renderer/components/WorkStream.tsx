// apps/desktop/src/renderer/components/WorkStream.tsx
//
// The CENTER primary work stream: one continuous conversation with ORION —
// user messages, streaming replies, compact activity cards from the active
// run, and the sticky command composer. Same canonical pipeline as Home
// (submitOrvynCommand); no duplicate chat exists anywhere else.
//
// Rich items stay concise per the co-worker model: actions and results, no
// chain-of-thought. Detail lives in the Workbench.

import React, { useCallback, useEffect, useRef, useState } from "react";
import { getChatMessages, isChatStreaming, subscribeChat, newChat, getActiveChatId, getActiveChatSettings, setActiveChatSetting, type ChatMessage } from "../chatSession";
import { partitionStreamMessages } from "../streamOrder";
import { ModelMenu, ReasoningMenu, AccessMenu, ExecutionTargetMenu, useComposerModels, ComposerModePills, ComposerSubmitButton, ghostBtn, writeComposerDefault } from "./ComposerControls";
import { ContextUsageMenu } from "./ContextUsageMenu";
import type { ReasoningEffort, AccessMode, ExecutionTargetSetting } from "./ComposerControls";
import { apiUrl, authHeaders } from "../connection";
import { submitOrvynCommand } from "../orvynCommand";
import { COMPOSER_HANDOFF_EVENT, takeComposerHandoff } from "../composerHandoff";
import { MessageContent } from "./MessageContent";
import { AgentActivityList, RunFooter } from "./AgentActivityList";
import "./ConversationActivity.css";
import { Attachment } from "./AttachmentBar";
import { IconPlus, IconRocket } from "./Icons";
import { AddMenu, ComposerChips, attachmentsFromChips, composerTriggerKey, contextNoteFromChips, type ComposerChip } from "./AddMenu";
import appIcon from "../assets/icon.png";
import type { CommandMode } from "../orvynIntent";
import type { AgentEvent } from "./AgentActivityList";

/** The single run state (owned by App, shared with the right ContextPanel). */
export interface RunView {
  events: AgentEvent[];
  status: string;
  runId: string | null;
  approve: (callId: string, approved: boolean, scope?: "once" | "mission") => Promise<void>;
  stop: () => Promise<void>;
  lastEventAt: number;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    turns: number;
    modelId?: string;
    contextTokens?: number;
    contextWindow?: number;
    contextBreakdown?: Record<string, number>;
    cacheHitRate?: number;
  } | null;
}

/** One durable queued follow-up, as the backend RunStore holds it. */
interface QueueItemView {
  id: string;
  runId: string;
  text: string;
  position: number;
}

export function WorkStream({
  projectRoot,
  projectName,
  run,
  onRunStarted,
  onOpenTerminal,
  onNavigate,
}: {
  projectRoot: string | null;
  projectName: string | null;
  run: RunView;
  onRunStarted: (runId: string | null) => void;
  onOpenTerminal?: () => void;
  onNavigate?: (view: string) => void;
}) {
  const [tick, setTick] = useState(0);
  const [prompt, setPrompt] = useState("");
  const [mode, setMode] = useState<CommandMode>(
    () => (localStorage.getItem("orvyn:composer-mode") as CommandMode) || "auto"
  );
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [chips, setChips] = useState<ComposerChip[]>([]);
  const [addOpen, setAddOpen] = useState(false);
  const plusRef = useRef<HTMLButtonElement>(null);
  const [requestedModelId, setRequestedModelId] = useState(() => localStorage.getItem("orvyn:run-model") || "auto");
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort>(
    () => (localStorage.getItem("orvyn:reasoning") as ReasoningEffort) || "auto"
  );
  const [accessMode, setAccessMode] = useState<AccessMode>(
    () => ((localStorage.getItem("orvyn:access") as AccessMode) || "auto_read")
  );
  const [executionTarget, setExecutionTarget] = useState<ExecutionTargetSetting>(
    () => ((localStorage.getItem("orvyn:execution-target") as ExecutionTargetSetting) || "auto")
  );
  const composerModels = useComposerModels();
  /** Conversation-scoped controls: switching chats re-applies that chat's
   *  explicit choices (falling back to the user-level defaults). */
  const lastChatId = useRef<string | null>(getActiveChatId());
  useEffect(() => {
    const id = getActiveChatId();
    if (id === lastChatId.current) return;
    lastChatId.current = id;
    const settings = getActiveChatSettings() ?? {};
    setRequestedModelId(settings.modelId ?? localStorage.getItem("orvyn:run-model") ?? "auto");
    setReasoningEffort((settings.reasoningEffort ?? (localStorage.getItem("orvyn:reasoning") as ReasoningEffort) ?? "auto"));
    setAccessMode(settings.permissionMode ?? ((localStorage.getItem("orvyn:access") as AccessMode) ?? "auto_read"));
  }, [tick]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * Durable follow-up queue — owned by the backend RunStore, scoped per run,
   * so it survives SSE reconnects and app restarts. `queueScopeRef` holds the
   * run whose items are still awaiting delivery; the active run's queue is
   * unioned into the same list so nothing hides during the handoff.
   */
  const [queue, setQueue] = useState<QueueItemView[]>([]);
  const queueScopeRef = useRef<string | null>(null);
  const [editing, setEditing] = useState<{ id: string; runId: string; text: string } | null>(null);
  const draggedId = useRef<string | null>(null);
  /** Auto-follow only while the user is at the bottom; scrolling up pauses it. */
  const [follow, setFollow] = useState(true);
  const [indexHint, setIndexHint] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!projectRoot) {
      setIndexHint(null);
      return;
    }
    let cancelled = false;
    const apply = async () => {
      try {
        const res = await fetch(apiUrl("/index/status"), { headers: authHeaders() });
        const data = await res.json();
        const st = String(data.stats?.status ?? "idle");
        if (cancelled) return;
        setIndexHint(st === "ready" ? "Indexed" : st === "indexing" ? "Indexing" : st === "stale" ? "Stale" : st === "degraded" ? "Degraded" : st === "error" ? "Index error" : null);
        if (st === "idle") {
          await fetch(apiUrl("/index/build"), {
            method: "POST",
            headers: { "Content-Type": "application/json", ...authHeaders() },
            body: JSON.stringify({ projectRoot, background: true }),
          });
        } else if (st === "stale") {
          await fetch(apiUrl("/index/update"), {
            method: "POST",
            headers: { "Content-Type": "application/json", ...authHeaders() },
            body: JSON.stringify({ projectRoot }),
          });
        }
      } catch {
        /* offline */
      }
    };
    void apply();
    const timer = window.setInterval(() => { void apply(); }, 10_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [projectRoot]);
  useEffect(() => subscribeChat(() => setTick((t) => t + 1)), []);
  const messages = getChatMessages();
  // Follow-ups stamped after run.started render under the run. Painting
  // them above the activity is what made a new message appear at the top.
  const { earlier: earlierMessages, later: laterMessages } = partitionStreamMessages(messages, run.events);

  // Follow the stream while the user is at the bottom; once they scroll up to
  // read, stop forcing scroll (a stream that yanks the view is unreadable).
  const onStreamScroll = () => {
    const el = scroller.current;
    if (!el) return;
    setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 80);
  };
  useEffect(() => {
    const el = scroller.current;
    if (el && follow) el.scrollTop = el.scrollHeight;
  }, [tick, messages.length, run.events, follow]);

  useEffect(() => {
    const el = scroller.current;
    const content = el?.firstElementChild;
    if (!el || !content) return;
    const observer = new ResizeObserver(() => { if (follow) el.scrollTop = el.scrollHeight; });
    observer.observe(content);
    return () => observer.disconnect();
  }, [follow]);

  // Ctrl+L focuses the composer from anywhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key.toLowerCase() === "l") {
        if (document.body.dataset.orvynWorkbench === "browser") return;
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    const onFocus = () => inputRef.current?.focus();
    document.addEventListener("orvyn:focus-composer", onFocus);
    // A prompt from Home that could not start comes back here, with why.
    const onHandoff = () => {
      const h = takeComposerHandoff();
      if (!h) return;
      setPrompt(h.text);
      setError(h.error ?? null);
      setTimeout(() => inputRef.current?.focus(), 0);
    };
    onHandoff();
    document.addEventListener(COMPOSER_HANDOFF_EVENT, onHandoff);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("orvyn:focus-composer", onFocus);
      document.removeEventListener(COMPOSER_HANDOFF_EVENT, onHandoff);
    };
  }, []);

  /**
   * Pulls authoritative queue state from the backend: the pending-delivery
   * scope first, then the attached run's queue. One GET per scope; the merged
   * list is display order (FIFO across scopes).
   */
  const runActive =
    run.status === "running" || run.status === "awaiting_approval" || run.status === "queued" || run.status === "cancelling";
  const refreshQueue = useCallback(async () => {
    const ids: string[] = [];
    if (queueScopeRef.current) ids.push(queueScopeRef.current);
    if (run.runId && !ids.includes(run.runId)) ids.push(run.runId);
    if (ids.length === 0) {
      setQueue([]);
      return;
    }
    let merged: QueueItemView[] = [];
    try {
      const lists = await Promise.all(
        ids.map(async (id) => {
          const r = await fetch(apiUrl(`/agent/stream/runs/${id}/queue`), { headers: authHeaders() });
          if (!r.ok) return [] as QueueItemView[];
          const d = await r.json();
          return (d.items ?? []) as QueueItemView[];
        })
      );
      for (const items of lists) for (const item of items) if (!merged.some((m) => m.id === item.id)) merged.push(item);
    } catch {
      return; // offline — the next mutation or queue event refetches
    }
    merged.sort((a, b) => a.position - b.position);
    setQueue(merged);
    if (merged.length === 0) queueScopeRef.current = null;
  }, [run.runId]);

  // Queue state refreshes on attach/transition, and whenever a queue event
  // lands in the run stream (covers mutations made from another window).
  useEffect(() => {
    void refreshQueue();
  }, [refreshQueue, runActive]);
  let lastQueueSeq = 0;
  for (let i = run.events.length - 1; i >= 0; i--) {
    if (run.events[i].type.startsWith("queue.")) {
      lastQueueSeq = run.events[i].sequence;
      break;
    }
  }
  useEffect(() => {
    if (lastQueueSeq > 0) void refreshQueue();
  }, [lastQueueSeq, refreshQueue]);

  /** Submits bypassing the active-run guard — used for queued delivery. */
  const deliver = useRef<(text: string) => void>(() => {});
  async function send(text?: string, bypassQueue = false) {
    const chipNote = contextNoteFromChips(chips);
    const chipAtt = attachmentsFromChips(chips);
    const instruction = (text ?? prompt).trim();
    const outgoing = chipNote && !text ? `${instruction}\n\n${chipNote}` : instruction;
    if (!instruction || busy) return;
    // While a run is active the instruction joins the DURABLE queue — the
    // backend RunStore holds it, so reconnects and restarts never lose it.
    if (runActive && !bypassQueue && run.runId) {
      setPrompt("");
      setAttachments([]);
      setChips([]);
      try {
        const r = await fetch(apiUrl(`/agent/stream/runs/${run.runId}/queue`), {
          method: "POST",
          headers: { "Content-Type": "application/json", ...authHeaders() },
          body: JSON.stringify({ text: outgoing }),
        });
        if (r.status === 409) {
          // The run settled between render and click — send it directly.
          await send(instruction, true);
          return;
        }
        if (!r.ok) throw new Error("Could not queue the follow-up.");
        queueScopeRef.current = run.runId;
        await refreshQueue();
      } catch (err: any) {
        setError(err.message);
      }
      return;
    }
    setBusy(true);
    setError(null);
    setFollow(true);
    try {
      const outcome = await submitOrvynCommand({
        prompt: outgoing,
        mode,
        source: "CHAT",
        projectRoot,
        previousRunId: run.runId,
        attachments: [...attachments, ...chipAtt],
        requestedModelId,
        reasoningEffort,
        permissionMode: accessMode,
        executionTarget,
      });
      if (outcome.kind === "error") throw new Error(outcome.error);
      setPrompt("");
      setAttachments([]);
      setChips([]);
      if (outcome.kind !== "chat") onRunStarted(outcome.runId);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }
  deliver.current = (text: string) => void send(text);

  /**
   * Persists a drag reorder: the list applies instantly (optimistic), then
   * each scope's run gets its new relative order. Positions are per-run in
   * the store, so a cross-scope drop becomes one PATCH per affected run.
   */
  function commitReorder(next: QueueItemView[]) {
    setQueue(next);
    const byRun = new Map<string, string[]>();
    for (const item of next) {
      const order = byRun.get(item.runId) ?? [];
      order.push(item.id);
      byRun.set(item.runId, order);
    }
    void Promise.all(
      [...byRun].map(([runId, order]) =>
        fetch(apiUrl(`/agent/stream/runs/${runId}/queue/reorder`), {
          method: "PATCH",
          headers: { "Content-Type": "application/json", ...authHeaders() },
          body: JSON.stringify({ order }),
        }).then((r) => {
          if (!r.ok) throw new Error("reorder rejected");
        })
      )
    )
      .then(() => void refreshQueue())
      .catch(() => {
        setError("Reorder failed — positions restored.");
        void refreshQueue();
      });
  }

  /** Steers one queued item into the live run at its next step. */
  async function steerQueuedItem(q: QueueItemView) {
    try {
      const r = await fetch(apiUrl(`/agent/stream/runs/${q.runId}/queue/${q.id}/steer`), {
        method: "POST",
        headers: authHeaders(),
      });
      if (r.status === 409) throw new Error("The run already finished — the item stays queued for delivery.");
      if (!r.ok) throw new Error("Steer failed.");
      await refreshQueue();
    } catch (err: any) {
      setError(err.message);
    }
  }

  /** Removes one queued item (cancel — recorded in the run's event log). */
  async function deleteQueuedItem(q: QueueItemView) {
    try {
      const r = await fetch(apiUrl(`/agent/stream/runs/${q.runId}/queue/${q.id}`), {
        method: "DELETE",
        headers: authHeaders(),
      });
      if (!r.ok) throw new Error("Could not remove the queued instruction.");
      if (editing?.id === q.id) setEditing(null);
      await refreshQueue();
    } catch (err: any) {
      setError(err.message);
    }
  }

  /** Saves the inline edit of a queued item (Enter or blur; Esc reverts). */
  async function saveEditedItem() {
    const cur = editing;
    if (!cur) return;
    const text = cur.text.trim();
    setEditing(null);
    if (!text || text === queue.find((q) => q.id === cur.id)?.text) return;
    try {
      const r = await fetch(apiUrl(`/agent/stream/runs/${cur.runId}/queue/${cur.id}`), {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ text }),
      });
      if (!r.ok) throw new Error("Could not update the queued instruction.");
      await refreshQueue();
    } catch (err: any) {
      setError(err.message);
    }
  }

  const streaming = isChatStreaming();
  const completion = [...run.events].reverse().find(e => e.type === "run.completed");
  const displayStatus = completion?.data.missionStatus === "BLOCKED" ? "needs attention" : Number(completion?.data.tasksFailed) > 0 ? "incomplete" : run.status;
  // Retry target: the run's own instruction, replayed as a NEW run.
  const retryInstruction = (run.events.find((e) => e.type === "run.started")?.data.instruction as string | undefined)?.trim() ?? null;
  // Stall clock: re-render every 5s while a run is active so "Still working…"
  // appears based on real elapsed time since the last event.
  const [, setClock] = useState(0);
  useEffect(() => {
    if (!runActive) return;
    const t = setInterval(() => setClock((c) => c + 1), 5000);
    return () => clearInterval(t);
  }, [runActive]);
  const stalled = run.lastEventAt > 0 && Date.now() - run.lastEventAt > 30_000;
  // Escape stops the active run — skipped when another handler already
  // claimed the key (e.g. a palette dismissal).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && runActive && !e.defaultPrevented) {
        e.preventDefault();
        void run.stop();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [runActive, run.stop]);

  // Queue delivery: when the attached run settles, the next queued follow-up
  // goes out on its own — same pipeline, same conversation. The item is
  // marked delivered server-side; the rest stay queued for their turn.
  useEffect(() => {
    if (runActive || queue.length === 0 || busy) return;
    const next = queue[0];
    void fetch(apiUrl(`/agent/stream/runs/${next.runId}/queue/${next.id}/delivered`), {
      method: "POST",
      headers: authHeaders(),
    })
      .catch(() => {})
      .finally(() => void refreshQueue());
    deliver.current(next.text);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runActive, queue, busy]);
  // The conversation's title. When a run is attached, the run IS the
  // conversation: its instruction names the work, and an unrelated chat
  // session from before must never leak its title (the "hi" bug) or its
  // messages into this workspace.
  const runInstruction = run.events.find((e) => e.type === "run.started")?.data.instruction;
  const title =
    (runInstruction ? String(runInstruction) : "").trim().split("\n")[0]?.slice(0, 60) ||
    (messages.find((m) => m.role === "user")?.content.trim().split("\n")[0] ?? "").slice(0, 60) ||
    "Work Stream";

  return (
    <div style={{ height: "100%", minWidth: 0, display: "flex", flexDirection: "column", background: "var(--orvyn-surface-1)" }}>
      {/* Compact workspace header — replaces the Hero once work begins. */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "8px 16px",
          borderBottom: "1px solid var(--orvyn-border-soft)",
          flexShrink: 0,
        }}
      >
        <img src={appIcon} alt="" width={18} height={18} style={{ borderRadius: 5 }} />
        <span style={{ fontSize: 12.5, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "46%" }}>
          {title}
        </span>
        {projectName && (
          <span style={{ fontSize: 10.5, color: "var(--orvyn-text-muted)", fontFamily: "var(--font-mono)" }}>
            {projectName}
          </span>
        )}
        {indexHint && (
          <span style={{ fontSize: 10, color: "var(--orvyn-text-muted)", letterSpacing: 0.3 }}>
            {indexHint}
          </span>
        )}
        {run.status !== "idle" && (
          <span
            style={{
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: 0.8,
              color:
                runActive && run.status !== "queued"
                  ? "var(--orvyn-purple-hi)"
                  : run.status === "queued"
                    ? "var(--orvyn-yellow)"
                    : displayStatus === "completed"
                      ? "var(--orvyn-green)"
                      : run.status === "cancelled"
                        ? "var(--orvyn-yellow)"
                        : "var(--orvyn-red)",
              border: "1px solid currentColor",
              borderRadius: 4,
              padding: "1px 7px",
            }}
          >
            {displayStatus.replace("_", " ").toUpperCase()}
          </span>
        )}
        {runActive && <WorkTimer startedAt={run.events.length > 0 ? run.events[0].timestamp : Date.now()} />}
        <span style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontSize: 10.5, color: "var(--orvyn-text-muted)" }}>Ctrl+L</span>
          <button
            title="New task — fresh conversation"
            onClick={() => {
              newChat();
              onRunStarted(null);
              setTimeout(() => document.dispatchEvent(new CustomEvent("orvyn:focus-composer")), 50);
            }}
            style={{
              background: "transparent",
              border: "1px solid var(--orvyn-border)",
              borderRadius: 5,
              color: "var(--orvyn-text-secondary)",
              fontSize: 11,
              padding: "3px 10px",
              cursor: "pointer",
            }}
          >
            New
          </button>
        </span>
      </div>

      {/* Run configuration truth line — what is actually executing this run:
          model (requested→actual), reasoning, access, execution location. */}
      {(() => {
        const started = run.events.find((e) => e.type === "run.started")?.data as any;
        const exec = run.events.find((e) => e.type === "run.execution")?.data as any;
        if (!started) return null;
        const modelLine =
          started.requestedModelId && started.requestedModelId !== "auto" && started.requestedModelId !== started.actualModelId
            ? `${started.requestedModelId} → ${started.actualModelId}`
            : started.actualModelId ?? "";
        const reasoning =
          started.reasoningEffortRequested && started.reasoningEffortRequested !== "auto"
            ? `Reasoning ${started.reasoningEffortRequested}${started.reasoningEffortApplied && started.reasoningEffortApplied !== "not supported by this model" ? ` (${started.reasoningEffortApplied})` : ""}`
            : "";
        const fallback = started.fallbackReason ? ` — fallback: ${started.fallbackReason}` : "";
        return (
          <div
            style={{
              display: "flex",
              gap: 12,
              flexWrap: "wrap",
              padding: "3px 16px 5px",
              borderBottom: "1px solid var(--orvyn-border-soft)",
              fontSize: 10,
              fontFamily: "var(--font-mono)",
              color: "var(--orvyn-text-muted)",
              flexShrink: 0,
            }}
          >
            <span>● {modelLine}{fallback}</span>
            {reasoning && <span>🧠 {reasoning}</span>}
            {started.permissionMode && <span>🛡 {started.permissionMode}</span>}
            {(exec?.executionLabel || exec?.location) && (
              <span>Execution: {String(exec.executionLabel || (String(exec.location).includes("OVH") ? "OVH Worker" : "Local"))}</span>
            )}
          </div>
        );
      })()}

      {/* The stream: older turns, then this run's activity, then follow-ups.
          Newest text is always the last block so it sits at the bottom. */}
      <div style={{ position: "relative", flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
        <div
          ref={scroller}
          onScroll={onStreamScroll}
          style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "14px 22px", minWidth: 0 }}
        >
          {/* Readable conversation measure: content never stretches edge to
              edge — the stream reads like a document, not a log viewer. */}
          <div style={{ maxWidth: 880, margin: "0 auto", minWidth: 0 }}>
          {messages.length === 0 && run.events.length === 0 && (
            <div style={{ padding: "48px 0", textAlign: "center" }}>
              <img src={appIcon} alt="ORVYN" width={40} height={40} style={{ borderRadius: 11, opacity: 0.9 }} />
              <div style={{ fontSize: 14, fontWeight: 600, marginTop: 10 }}>What do you want ORVYN to accomplish?</div>
              <div style={{ fontSize: 12, color: "var(--orvyn-text-muted)", marginTop: 4 }}>
                Ask, build, fix, deploy, research — this stream is the conversation and the work.
              </div>
            </div>
          )}

        {earlierMessages.map((m, i) => (
          <ChatTurn key={`earlier-${i}`} message={m} live={streaming && m === messages[messages.length - 1]} />
        ))}

        {/* The run instruction is already represented by the canonical chat
            message. Never render it again here: duplicate user bubbles make
            the stream look like two conversations and break chronology. */}
        {runActive && <div role="status" style={{fontSize:12,color:"var(--text-secondary)",padding:"8px 0",borderBottom:"1px solid var(--border)"}}>Working{run.events[0] ? ` for ${Math.max(0,Math.floor((Date.now()-run.events[0].timestamp)/1000))}s` : "…"}</div>}

        {/* Activity from the attached run — the presentation reducer's
            conversation: assistant text, compact tool rows, approvals. */}
        {(run.events.length > 0 || runActive) && (
          <div style={{ margin: "8px 0 4px", minWidth: 0 }}>
            <AgentActivityList events={run.events} status={run.status} onApprove={run.approve} />
            <RunFooter events={run.events} runId={run.runId} finished={run.status === "completed" || run.status === "error" || run.status === "cancelled"} />
          </div>
        )}

        {/* Finished runs can be retried: a NEW run with the same instruction,
            never an overwrite of the historical one. */}
        {(run.status === "error" || run.status === "cancelled") && retryInstruction && (
          <div style={{ margin: "6px 0" }}>
            <button
              onClick={() => {
                onRunStarted(null);
                void send(retryInstruction, true);
              }}
              style={{
                background: "transparent",
                border: "1px solid var(--orvyn-border)",
                borderRadius: 6,
                color: "var(--orvyn-text-secondary)",
                fontSize: 11.5,
                padding: "4px 12px",
                cursor: "pointer",
              }}
            >
              ↻ Retry this request
            </button>
          </div>
        )}

        {/* Stall honesty: an active run with no events for 30s says so,
            instead of silently looking frozen. */}
        {runActive && stalled && (
          <div style={{ fontSize: 11.5, color: "var(--orvyn-text-muted)", fontStyle: "italic", margin: "6px 0" }}>
            Still working… (no new activity for {Math.round((Date.now() - run.lastEventAt) / 1000)}s)
          </div>
        )}

        {/* Dev-only Run Inspector: ids, state, sequence, model, elapsed —
            never shown in production builds. */}
        {import.meta.env.DEV && run.runId && (
          <div
            style={{
              marginTop: 10,
              padding: "6px 10px",
              borderRadius: 6,
              border: "1px dashed var(--orvyn-border)",
              fontFamily: "var(--font-mono)",
              fontSize: 10,
              color: "var(--orvyn-text-muted)",
              lineHeight: 1.7,
              overflowWrap: "anywhere",
            }}
          >
            <div>RUN INSPECTOR (dev)</div>
            <div>runId: {run.runId}</div>
            <div>status: {run.status} · events: {run.events.length} · seq: {run.events.length > 0 ? run.events[run.events.length - 1].sequence : 0}</div>
            <div>
              model: {run.usage?.modelId ?? "(usage event pending)"} · tokens: {run.usage?.promptTokens ?? 0}↑ {run.usage?.completionTokens ?? 0}↓ · turns: {run.usage?.turns ?? 0}
            </div>
            <div>last event: {run.events.length > 0 ? `${run.events[run.events.length - 1].type} @ ${new Date(run.lastEventAt || run.events[run.events.length - 1].timestamp).toLocaleTimeString()}` : "—"}</div>
          </div>
        )}

        {laterMessages.map((m, i) => (
          <ChatTurn key={`later-${i}`} message={m} live={streaming && m === messages[messages.length - 1]} />
        ))}
        </div>
        </div>
        {!follow && (
          <button
            onClick={() => {
              const el = scroller.current;
              if (el) el.scrollTop = el.scrollHeight;
              setFollow(true);
            }}
            style={{
              position: "absolute",
              bottom: 12,
              left: "50%",
              transform: "translateX(-50%)",
              background: "var(--orvyn-surface-2)",
              border: "1px solid var(--orvyn-border)",
              borderRadius: 999,
              color: "var(--orvyn-text-secondary)",
              fontSize: 11,
              padding: "4px 12px",
              cursor: "pointer",
              boxShadow: "0 6px 18px rgba(3,6,14,0.5)",
            }}
          >
            ↓ Jump to latest
          </button>
        )}
      </div>

      {/* Sticky command composer — same pipeline as Home. */}
      <div style={{ flexShrink: 0, padding: "10px 16px 12px", borderTop: "1px solid var(--orvyn-border-soft)" }}>
        {queue.length > 0 && (
          <div style={{ marginBottom: 8, display: "flex", flexDirection: "column", gap: 4 }}>
            <div style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: 1, color: "var(--orvyn-text-muted)", padding: "0 2px" }}>
              UP NEXT · {queue.length} QUEUED — DELIVERED IN ORDER WHEN THIS RUN SETTLES
            </div>
            {queue.map((q, i) => (
              <div
                key={q.id}
                draggable={editing?.id !== q.id}
                onDragStart={(e) => {
                  draggedId.current = q.id;
                  e.dataTransfer.effectAllowed = "move";
                }}
                onDragEnd={() => {
                  draggedId.current = null;
                }}
                onDragOver={(e) => {
                  if (draggedId.current && draggedId.current !== q.id) e.preventDefault();
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  const dragId = draggedId.current;
                  draggedId.current = null;
                  if (!dragId || dragId === q.id) return;
                  const from = queue.findIndex((x) => x.id === dragId);
                  const to = queue.findIndex((x) => x.id === q.id);
                  if (from < 0 || to < 0) return;
                  const next = [...queue];
                  const [moved] = next.splice(from, 1);
                  next.splice(to, 0, moved);
                  commitReorder(next);
                }}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "4px 10px",
                  borderRadius: 6,
                  border: "1px dashed var(--orvyn-border)",
                  fontSize: 11.5,
                  color: "var(--orvyn-text-secondary)",
                  background: "var(--orvyn-surface-1)",
                }}
              >
                <span title="Drag to reorder" style={{ cursor: "grab", color: "var(--orvyn-text-muted)", fontSize: 11, lineHeight: 1, userSelect: "none", flexShrink: 0 }}>⠿</span>
                <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, fontWeight: 700, color: "var(--orvyn-purple-hi)", width: 14, textAlign: "center", flexShrink: 0 }}>{i + 1}</span>
                {editing?.id === q.id ? (
                  <input
                    autoFocus
                    value={editing.text}
                    onChange={(e) => setEditing({ id: q.id, runId: q.runId, text: e.target.value })}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        void saveEditedItem();
                      } else if (e.key === "Escape") {
                        e.preventDefault();
                        setEditing(null);
                      }
                    }}
                    onBlur={() => void saveEditedItem()}
                    style={{
                      flex: 1,
                      minWidth: 0,
                      background: "var(--orvyn-bg)",
                      border: "1px solid var(--orvyn-purple)",
                      borderRadius: 4,
                      color: "var(--orvyn-text)",
                      fontSize: 11.5,
                      padding: "2px 6px",
                      outline: "none",
                      fontFamily: "inherit",
                    }}
                  />
                ) : (
                  <span
                    title={q.text}
                    onDoubleClick={() => setEditing({ id: q.id, runId: q.runId, text: q.text })}
                    style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                  >
                    {q.text}
                  </span>
                )}
                <button
                  title="Steer — deliver to the agent at its next step"
                  onClick={() => void steerQueuedItem(q)}
                  disabled={!runActive}
                  style={{ ...ghostBtn(), opacity: runActive ? 1 : 0.4, cursor: runActive ? "pointer" : "default" }}
                >
                  ⤳
                </button>
                <button
                  title="Edit"
                  onClick={() => setEditing({ id: q.id, runId: q.runId, text: q.text })}
                  style={ghostBtn()}
                >
                  ✎
                </button>
                <button title="Remove" onClick={() => void deleteQueuedItem(q)} style={ghostBtn()}>
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}
        {error && <div style={{ color: "var(--orvyn-red)", fontSize: 11.5, marginBottom: 6 }}>{error}</div>}
        <div
          style={{
            background: "var(--orvyn-bg)",
            border: "1px solid var(--orvyn-border)",
            borderRadius: "var(--orvyn-radius-md)",
            padding: 10,
          }}
        >
          <textarea
            ref={inputRef}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send();
                return;
              }
              const trigger = composerTriggerKey(e.key);
              if (trigger && !e.ctrlKey && !e.metaKey && !e.altKey) {
                const el = e.currentTarget;
                const atEdge = el.selectionStart === 0 || /\s/.test(el.value[el.selectionStart - 1] ?? " ");
                if (atEdge) {
                  e.preventDefault();
                  setAddOpen(true);
                }
              }
            }}
            rows={2}
            placeholder={runActive ? "Keep typing to queue follow-up changes…" : "Ask ORVYN to build, fix, deploy, research…"}
            style={{
              width: "100%",
              background: "transparent",
              border: "none",
              outline: "none",
              color: "var(--orvyn-text)",
              fontSize: 13,
              resize: "none",
              fontFamily: "inherit",
            }}
          />
          <ComposerChips
            chips={chips}
            onRemove={(id) => setChips((prev) => prev.filter((c) => c.id !== id))}
          />
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 6, flexWrap: "wrap" }}>
            <button
              ref={plusRef}
              type="button"
              title="Add attachments, context, skills, or plugins"
              aria-label="Add attachments, context, skills, or plugins"
              aria-expanded={addOpen}
              onClick={() => setAddOpen((v) => !v)}
              style={{
                ...ghostBtn(),
                background: addOpen ? "rgba(108,92,255,0.18)" : "transparent",
                borderColor: addOpen ? "var(--orvyn-purple)" : "var(--orvyn-border)",
                color: addOpen ? "var(--orvyn-text)" : "var(--orvyn-text-secondary)",              }}
            >
              <IconPlus size={14} />
            </button>
            <AddMenu
              open={addOpen}
              onOpenChange={setAddOpen}
              selected={chips}
              onSelectedChange={(next) => {
                setChips(next);
                setAttachments(attachmentsFromChips(next));
              }}
              onOpenTerminal={onOpenTerminal}
              onNavigate={onNavigate}
              projectRoot={projectRoot}
              anchorRef={plusRef}
            />
            {(attachments.length > 0 || chips.length > 0) && (
              <span style={{ fontSize: 11, color: "var(--orvyn-cyan)" }}>
                {chips.length || attachments.length} attached
              </span>
            )}
            <ComposerModePills
              mode={mode}
              onChange={(m) => {
                setMode(m as CommandMode);
                writeComposerDefault("mode", m);
              }}
            />
            <AccessMenu
              value={accessMode}
              onChange={(v) => {
                setAccessMode(v);
                writeComposerDefault("permissionMode", v);
                setActiveChatSetting("permissionMode", v);
              }}
            />
            <ExecutionTargetMenu
              value={executionTarget}
              onChange={(v) => {
                setExecutionTarget(v);
                writeComposerDefault("executionTarget", v);
              }}
            />
            <ModelMenu
              models={composerModels}
              value={requestedModelId}
              onChange={(id) => {
                setRequestedModelId(id);
                writeComposerDefault("modelId", id);
                setActiveChatSetting("modelId", id);
              }}
            />
            <ReasoningMenu
              value={reasoningEffort}
              models={composerModels}
              modelId={requestedModelId}
              onChange={(v) => {
                setReasoningEffort(v);
                writeComposerDefault("reasoningEffort", v);
                setActiveChatSetting("reasoningEffort", v);
              }}
            />
            <ContextUsageMenu
              state={{
                usage: run.usage,
                modelContextWindow: composerModels.find((m) => m.id === requestedModelId)?.contextWindow,
              }}
            />
            {runActive ? (
              <button
                onClick={() => void run.stop()}
                title="Stop current run (Esc)"
                style={{
                  marginLeft: "auto",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 7,
                  background: "transparent",
                  border: "1px solid var(--orvyn-red)",
                  borderRadius: "var(--orvyn-radius-sm)",
                  color: "var(--orvyn-red)",
                  padding: "6px 18px",
                  fontSize: 12.5,
                  fontWeight: 600,
                  cursor: "pointer",
                }}
              >
                <span style={{ width: 9, height: 9, background: "var(--orvyn-red)", borderRadius: 2, display: "inline-block" }} />
                Stop
              </button>
            ) : (
              <ComposerSubmitButton
                label="Send"
                icon={<IconRocket size={13} />}
                onClick={() => void send()}
                disabled={!prompt.trim() || busy}
                title="Send (Enter)"
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}



/** "Working for 4s" — self-contained 1s ticker so only this chip re-renders,
 *  never the whole conversation (spec Part 9). */
function WorkTimer({ startedAt }: { startedAt: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const s = Math.max(0, Math.floor((now - startedAt) / 1000));
  const label = s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return (
    <span style={{ fontSize: 10.5, color: "var(--orvyn-text-muted)", fontStyle: "italic", display: "inline-flex", alignItems: "center", gap: 5 }}>
      <span className="activity-pulse" style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--orvyn-purple)", display: "inline-block" }} />
      Working for {label}
    </span>
  );
}

function ChatTurn({ message, live }: { message: ChatMessage; live: boolean }) {
  if (message.role === "user") {
    return (
      <div style={{ display: "flex", justifyContent: "flex-end", margin: "14px 0 10px" }}>
        <div className="user-pill">
          {message.content}
          {message.attachments && message.attachments.length > 0 && (
            <div style={{ fontSize: 10.5, color: "var(--orvyn-cyan)", marginTop: 4 }}>
              {message.attachments.length} attachment{message.attachments.length === 1 ? "" : "s"}
            </div>
          )}
        </div>
      </div>
    );
  }
  return (
    <div style={{ display: "flex", gap: 10, margin: "12px 0", minWidth: 0 }}>
      <img src={appIcon} alt="ORION" width={26} height={26} style={{ borderRadius: 7, flexShrink: 0, marginTop: 2 }} />
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 4 }}>
          <span style={{ fontSize: 12, fontWeight: 700 }}>ORION</span>
          <span
            style={{
              fontSize: 8,
              fontWeight: 700,
              letterSpacing: 1,
              color: "var(--orvyn-purple-hi)",
              border: "1px solid rgba(124,92,255,0.45)",
              borderRadius: 4,
              padding: "1px 5px",
            }}
          >
            ASSISTANT
          </span>
        </div>
        <div style={{ fontSize: 13, color: "var(--orvyn-text)", minWidth: 0 }}>
          {!message.content && live ? (
            <span style={{ color: "var(--orvyn-text-muted)", fontStyle: "italic" }}>
              Thinking…
            </span>
          ) : (
            <MessageContent content={message.content} streaming={live} />
          )}
        </div>
      </div>
    </div>
  );
}
