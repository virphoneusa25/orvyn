// apps/desktop/src/renderer/components/WorkStream.tsx
//
// The CENTER primary work stream: one continuous conversation with Astra —
// user messages, streaming replies, compact activity cards from the active
// run, and the sticky command composer. Same canonical pipeline as Home
// (submitOrvynCommand); no duplicate chat exists anywhere else.
//
// Rich items stay concise per the co-worker model: actions and results, no
// chain-of-thought. Detail lives in the right ContextPanel.

import React, { useEffect, useRef, useState } from "react";
import { getChatMessages, isChatStreaming, subscribeChat, newChat } from "../chatSession";
import { apiUrl, authHeaders } from "../connection";
import { submitOrvynCommand } from "../orvynCommand";
import { MessageContent } from "./MessageContent";
import { AgentActivityList, RunFooter } from "./AgentActivityList";
import { Attachment, fileToAttachment } from "./AttachmentBar";
import { IconPaperclip, IconRocket } from "./Icons";
import appIcon from "../assets/icon.png";
import type { CommandMode } from "../orvynIntent";
import type { AgentEvent } from "./AgentActivityList";

const MODES: { id: CommandMode; label: string }[] = [
  { id: "auto", label: "Auto" },
  { id: "code", label: "Code" },
  { id: "server", label: "Server" },
  { id: "research", label: "Research" },
  { id: "deploy", label: "Deploy" },
  { id: "automate", label: "Automate" },
];

/** The single run state (owned by App, shared with the right ContextPanel). */
export interface RunView {
  events: AgentEvent[];
  status: string;
  runId: string | null;
  approve: (callId: string, approved: boolean, scope?: "once" | "mission") => Promise<void>;
  stop: () => Promise<void>;
  lastEventAt: number;
  usage?: { promptTokens: number; completionTokens: number; turns: number; modelId?: string } | null;
}

export function WorkStream({
  projectRoot,
  projectName,
  run,
  onRunStarted,
}: {
  projectRoot: string | null;
  projectName: string | null;
  run: RunView;
  onRunStarted: (runId: string | null) => void;
}) {
  const [, setTick] = useState(0);
  const [prompt, setPrompt] = useState("");
  const [mode, setMode] = useState<CommandMode>(
    () => (localStorage.getItem("orvyn:composer-mode") as CommandMode) || "auto"
  );
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Follow-ups submitted while a run is active — delivered when it ends. */
  const [queued, setQueued] = useState<{ id: number; text: string }[]>([]);
  const queueId = useRef(0);
  /** Auto-follow only while the user is at the bottom; scrolling up pauses it. */
  const [follow, setFollow] = useState(true);
  const scroller = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const attachRef = useRef<HTMLInputElement>(null);

  useEffect(() => subscribeChat(() => setTick((t) => t + 1)), []);
  const messages = getChatMessages();

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
  }, [messages.length, run.events.length, follow]);

  // Ctrl+L focuses the composer from anywhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key.toLowerCase() === "l") {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    const onFocus = () => inputRef.current?.focus();
    document.addEventListener("orvyn:focus-composer", onFocus);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("orvyn:focus-composer", onFocus);
    };
  }, []);

  /** Submits bypassing the active-run guard — used for queued delivery. */
  const deliver = useRef<(text: string) => void>(() => {});
  async function send(text?: string, bypassQueue = false) {
    const instruction = (text ?? prompt).trim();
    if (!instruction || busy) return;
    // While a run is active the instruction joins the queue — it is delivered
    // when the run reaches a terminal state, never silently dropped into it.
    if (runActive && !bypassQueue) {
      setQueued((q) => [...q, { id: queueId.current++, text: instruction }]);
      setPrompt("");
      setAttachments([]);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const outcome = await submitOrvynCommand({
        prompt: instruction,
        mode,
        source: "CHAT",
        projectRoot,
        attachments,
      });
      if (outcome.kind === "error") throw new Error(outcome.error);
      setPrompt("");
      setAttachments([]);
      if (outcome.kind !== "chat") onRunStarted(outcome.runId);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }
  deliver.current = (text: string) => void send(text);

  const runActive =
    run.status === "running" || run.status === "awaiting_approval" || run.status === "queued" || run.status === "cancelling";
  const streaming = isChatStreaming();
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
  // goes out on its own — same pipeline, same conversation.
  useEffect(() => {
    if (runActive || queued.length === 0) return;
    if (busy) return;
    const [next, ...rest] = queued;
    setQueued(rest);
    deliver.current(next.text);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runActive, queued, busy]);
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
                    : run.status === "completed"
                      ? "var(--orvyn-green)"
                      : run.status === "cancelled"
                        ? "var(--orvyn-yellow)"
                        : "var(--orvyn-red)",
              border: "1px solid currentColor",
              borderRadius: 4,
              padding: "1px 7px",
            }}
          >
            {run.status.replace("_", " ").toUpperCase()}
          </span>
        )}
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

      {/* The stream: conversation + activity, top to bottom. */}
      <div style={{ position: "relative", flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
        <div
          ref={scroller}
          onScroll={onStreamScroll}
          style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "14px 22px", minWidth: 0 }}
        >
          {messages.length === 0 && run.events.length === 0 && (
            <div style={{ padding: "48px 0", textAlign: "center" }}>
              <img src={appIcon} alt="ORVYN" width={40} height={40} style={{ borderRadius: 11, opacity: 0.9 }} />
              <div style={{ fontSize: 14, fontWeight: 600, marginTop: 10 }}>What do you want ORVYN to accomplish?</div>
              <div style={{ fontSize: 12, color: "var(--orvyn-text-muted)", marginTop: 4 }}>
                Ask, build, fix, deploy, research — this stream is the conversation and the work.
              </div>
            </div>
          )}

        {messages.map((m, i) =>
          m.role === "user" ? (
            <div key={i} style={{ display: "flex", justifyContent: "flex-end", margin: "10px 0" }}>
              <div
                style={{
                  maxWidth: "72%",
                  background: "rgba(108,92,255,0.14)",
                  border: "1px solid rgba(108,92,255,0.35)",
                  borderRadius: "var(--orvyn-radius-md)",
                  borderTopRightRadius: 4,
                  padding: "8px 12px",
                  fontSize: 13,
                  color: "var(--orvyn-text)",
                  whiteSpace: "pre-wrap",
                }}
              >
                {m.content}
                {m.attachments && m.attachments.length > 0 && (
                  <div style={{ fontSize: 10.5, color: "var(--orvyn-cyan)", marginTop: 4 }}>
                    {m.attachments.length} attachment{m.attachments.length === 1 ? "" : "s"}
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div key={i} style={{ display: "flex", gap: 10, margin: "12px 0", minWidth: 0 }}>
              <img src={appIcon} alt="Astra" width={26} height={26} style={{ borderRadius: 7, flexShrink: 0, marginTop: 2 }} />
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 4 }}>
                  <span style={{ fontSize: 12, fontWeight: 700 }}>Astra</span>
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
                    ORCHESTRATOR
                  </span>
                </div>
                <div style={{ fontSize: 13, color: "var(--orvyn-text)", minWidth: 0 }}>
                  {/* The immediate working state — never an empty screen while
                      the model is on the wire. */}
                  {!m.content && i === messages.length - 1 && streaming ? (
                    <span style={{ color: "var(--orvyn-text-muted)", fontStyle: "italic" }}>
                      Astra is analyzing your request…
                    </span>
                  ) : (
                    <MessageContent content={m.content} />
                  )}
                </div>
              </div>
            </div>
          )
        )}

        {/* Activity from the attached run — the presentation reducer's
            conversation: assistant text, compact tool rows, approvals. */}
        {run.events.length > 0 && (
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
        {queued.length > 0 && (
          <div style={{ marginBottom: 8, display: "flex", flexDirection: "column", gap: 4 }}>
            {queued.map((q) => (
              <div
                key={q.id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "4px 10px",
                  borderRadius: 6,
                  border: "1px dashed var(--orvyn-border)",
                  fontSize: 11.5,
                  color: "var(--orvyn-text-secondary)",
                }}
              >
                <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: 1, color: "var(--orvyn-purple-hi)" }}>QUEUED</span>
                <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{q.text}</span>
                <button
                  title="Send now — bypasses the queue"
                  onClick={() => {
                    setQueued((x) => x.filter((y) => y.id !== q.id));
                    void send(q.text, true);
                  }}
                  style={ghostBtn()}
                >
                  ▶
                </button>
                <button title="Edit" onClick={() => { setPrompt(q.text); setQueued((x) => x.filter((y) => y.id !== q.id)); }} style={ghostBtn()}>
                  ✎
                </button>
                <button title="Remove" onClick={() => setQueued((x) => x.filter((y) => y.id !== q.id))} style={ghostBtn()}>
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
              }
            }}
            rows={2}
            placeholder="Ask ORVYN to build, fix, deploy, research…"
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
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 6, flexWrap: "wrap" }}>
            <button
              title="Attach files or images"
              onClick={() => attachRef.current?.click()}
              style={ghostBtn()}
            >
              <IconPaperclip size={13} />
            </button>
            <input
              ref={attachRef}
              type="file"
              multiple
              style={{ display: "none" }}
              onChange={async (e) => {
                const files = Array.from(e.target.files ?? []);
                const loaded: Attachment[] = [];
                for (const f of files) {
                  try {
                    const a = await fileToAttachment(f);
                    if (a) loaded.push(a);
                  } catch {
                    /* skip unreadable */
                  }
                }
                setAttachments((prev) => [...prev, ...loaded]);
                e.target.value = "";
              }}
            />
            {attachments.length > 0 && (
              <span style={{ fontSize: 11, color: "var(--orvyn-cyan)" }}>{attachments.length} attached</span>
            )}
            {MODES.map((m) => (
              <button
                key={m.id}
                onClick={() => {
                  setMode(m.id);
                  localStorage.setItem("orvyn:composer-mode", m.id);
                }}
                style={{
                  background: mode === m.id ? "var(--orvyn-purple)" : "transparent",
                  border: `1px solid ${mode === m.id ? "var(--orvyn-purple)" : "var(--orvyn-border)"}`,
                  borderRadius: 999,
                  color: mode === m.id ? "#fff" : "var(--orvyn-text-secondary)",
                  padding: "3px 10px",
                  fontSize: 11,
                  cursor: "pointer",
                }}
              >
                {m.label}
              </button>
            ))}
            <span style={{ fontSize: 11, color: "var(--orvyn-text-muted)" }}>Astra</span>
            <ModelPicker />
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
              <button
                onClick={() => void send()}
                disabled={!prompt.trim() || busy}
                style={{
                  marginLeft: "auto",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  background: "var(--orvyn-purple)",
                  border: "none",
                  borderRadius: "var(--orvyn-radius-sm)",
                  color: "#fff",
                  padding: "6px 18px",
                  fontSize: 12.5,
                  fontWeight: 600,
                  cursor: !prompt.trim() || busy ? "default" : "pointer",
                  opacity: !prompt.trim() || busy ? 0.55 : 1,
                }}
              >
                <IconRocket size={13} /> Send
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function ghostBtn(): React.CSSProperties {
  return {
    background: "transparent",
    border: "1px solid var(--orvyn-border)",
    borderRadius: 6,
    color: "var(--orvyn-text-secondary)",
    width: 24,
    height: 24,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    cursor: "pointer",
    flexShrink: 0,
  };
}

/**
 * Model for the next runs. Auto = the router decides; an explicit pick is
 * written to the REAL routing overrides (POST /routing, capability-validated
 * by the backend, honored by the model router and persisted) — this is the
 * same path the Model Manager writes, so the picker genuinely controls the
 * model that executes. Takes effect on the NEXT run; a run already in flight
 * keeps its model.
 */
function ModelPicker() {
  const [models, setModels] = useState<{ id: string; name: string }[]>([]);
  const [current, setCurrent] = useState<string>("auto");
  const [busy, setBusy] = useState(false);

  const load = () => {
    fetch(apiUrl("/models"))
      .then((r) => r.json())
      .then((d) => setModels((d.models ?? []).filter((m: any) => m.capabilities?.chat).map((m: any) => ({ id: m.id, name: m.name ?? m.id }))))
      .catch(() => {});
    fetch(apiUrl("/routing"))
      .then((r) => r.json())
      .then((d) => setCurrent(d.overrides?.executor ?? d.overrides?.chat ?? "auto"))
      .catch(() => {});
  };
  useEffect(load, []);

  async function pick(id: string) {
    setBusy(true);
    try {
      if (id === "auto") {
        // Clear both lanes — the router returns to its configured defaults.
        await fetch(apiUrl("/routing/executor"), { method: "DELETE", headers: authHeaders() });
        await fetch(apiUrl("/routing/chat"), { method: "DELETE", headers: authHeaders() });
        setCurrent("auto");
      } else {
        // Executor drives mission workers; chat drives conversation turns.
        await fetch(apiUrl("/routing"), {
          method: "POST",
          headers: { "Content-Type": "application/json", ...authHeaders() },
          body: JSON.stringify({ task: "executor", modelId: id }),
        });
        await fetch(apiUrl("/routing"), {
          method: "POST",
          headers: { "Content-Type": "application/json", ...authHeaders() },
          body: JSON.stringify({ task: "chat", modelId: id }),
        });
        setCurrent(id);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <select
      title="Model for the next runs — Auto lets the router decide"
      value={current}
      disabled={busy}
      onChange={(e) => void pick(e.target.value)}
      style={{
        background: "transparent",
        border: "1px solid var(--orvyn-border)",
        borderRadius: 6,
        color: "var(--orvyn-text-secondary)",
        fontSize: 10.5,
        padding: "3px 6px",
        maxWidth: 150,
        cursor: "pointer",
      }}
    >
      <option value="auto">Auto</option>
      {models.map((m) => (
        <option key={m.id} value={m.id}>
          {m.name}
        </option>
      ))}
    </select>
  );
}

