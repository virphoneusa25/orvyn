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
import { submitOrvynCommand } from "../orvynCommand";
import { MessageContent } from "./MessageContent";
import { AgentActivityList, RunFooter } from "./AgentActivityList";
import { LiveActivity } from "./MissionPlan";
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
  const scroller = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const attachRef = useRef<HTMLInputElement>(null);

  useEffect(() => subscribeChat(() => setTick((t) => t + 1)), []);
  const messages = getChatMessages();

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" });
  }, [messages.length, run.events.length]);

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

  async function send() {
    const text = prompt.trim();
    if (!text || busy) return;
    setBusy(true);
    setError(null);
    try {
      const outcome = await submitOrvynCommand({
        prompt: text,
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

  const runActive = run.status === "running" || run.status === "awaiting_approval" || run.status === "cancelling";
  const streaming = isChatStreaming();
  // The conversation's title: the first user message of this session.
  const firstUser = messages.find((m) => m.role === "user");
  const title = firstUser ? firstUser.content.trim().split("\n")[0]!.slice(0, 60) : "Work Stream";

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
              color: runActive ? "var(--orvyn-purple-hi)" : run.status === "completed" ? "var(--orvyn-green)" : run.status === "cancelled" ? "var(--orvyn-yellow)" : "var(--orvyn-red)",
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
      <div ref={scroller} style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "14px 22px", minWidth: 0 }}>
        {messages.length === 0 && run.events.length === 0 && (
          <div style={{ padding: "48px 0", textAlign: "center" }}>
            <img src={appIcon} alt="ORVYN" width={40} height={40} style={{ borderRadius: 11, opacity: 0.9 }} />
            <div style={{ fontSize: 14, fontWeight: 600, marginTop: 10 }}>What do you want ORVYN to accomplish?</div>
            <div style={{ fontSize: 12, color: "var(--orvyn-text-muted)", marginTop: 4 }}>
              Ask, build, fix, deploy — this stream is the conversation and the work.
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

        {/* Activity from the attached run — compact cards, no reasoning. */}
        {run.events.length > 0 && (
          <div style={{ margin: "8px 0 4px", minWidth: 0 }}>
            <AgentActivityList events={run.events} status={run.status} onApprove={run.approve} />
            <LiveActivity events={run.events} />
            <RunFooter events={run.events} runId={run.runId} finished={run.status === "completed" || run.status === "error" || run.status === "cancelled"} />
          </div>
        )}
      </div>

      {/* Sticky command composer — same pipeline as Home. */}
      <div style={{ flexShrink: 0, padding: "10px 16px 12px", borderTop: "1px solid var(--orvyn-border-soft)" }}>
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

