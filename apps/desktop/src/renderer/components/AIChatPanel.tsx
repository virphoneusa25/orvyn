import React, { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { wsUrl } from "../connection";
import {
  appendAssistantDelta,
  deleteChatSession,
  finishAssistantTurn,
  getActiveChat,
  getActiveChatId,
  getChatMessages,
  initChatHistory,
  isChatStreaming,
  ensureChatForRun,
  listChatSessions,
  newChat,
  openChatSession,
  startUserTurn,
  subscribeChat,
} from "../chatSession";
import { WorkspaceState } from "../orvyn-bridge";
import { MessageContent } from "./MessageContent";
import { AgentActivityList, liveActivityLabel, RunFooter } from "./AgentActivityList";
import { AgentComposer, Attachment } from "./AgentComposer";
import { isRunFinished, useAgentRun } from "../useAgentRun";
import { apiUrl, authHeaders } from "../connection";
import { looksLikeImageRequest, stripImagePrefix, requestGeneratedImages } from "../imageIntent";
import lockup from "../assets/logo-lockup.png";
import appIcon from "../assets/icon.png";

export function AIChatPanel({
  currentFile,
  workspace,
  projectFiles = [],
  variant = "panel",
  onOpenFolder,
  onOpenFile,
  onOpenRecent,
  onApplyCode,
}: {
  currentFile: { path: string; content: string } | null;
  workspace: WorkspaceState | null;
  projectFiles?: string[];
  variant?: "panel" | "full";
  onOpenFolder?: () => void;
  onOpenFile?: () => void;
  onOpenRecent?: (folder: string) => void;
  onApplyCode?: (code: string) => void;
}) {
  const [, setTick] = useState(0);
  const [input, setInput] = useState("");
  const [useRag, setUseRag] = useState(true);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [chatMode, setChatMode] = useState<string>("ask");
  const [forceImage, setForceImage] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const socketRef = useRef<WebSocket | null>(null);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const [atBottom, setAtBottom] = useState(true);
  const agent = useAgentRun(workspace?.root ?? null);
  const live = liveActivityLabel(agent.events);
  // "cancelling" still counts as busy — the run is winding down, so neither a
  // new message nor a second Stop should be possible.
  const agentBusy =
    agent.status === "running" || agent.status === "awaiting_approval" || agent.status === "cancelling";

  const messages = getChatMessages();
  const streaming = isChatStreaming();

  useEffect(
    () =>
      subscribeChat(() => {
        flushSync(() => setTick((n) => n + 1));
      }),
    []
  );

  useEffect(() => {
    void initChatHistory();
  }, []);

  useEffect(() => {
    scrollerRef.current?.scrollTo({ top: scrollerRef.current.scrollHeight });
  }, [messages, streaming, agent.events.length]);

  const mention = parseMention(input);
  const mentionHits = mention
    ? projectFiles.filter((f) => f.toLowerCase().includes(mention.query.toLowerCase())).slice(0, 12)
    : [];

  async function mentionedContext(text: string): Promise<{ path: string; content: string }[]> {
    const names = [...text.matchAll(/@([^\s@]+)/g)].map((m) => m[1]);
    const unique = [...new Set(names)].slice(0, 8);
    const out: { path: string; content: string }[] = [];
    for (const name of unique) {
      const path = projectFiles.find((f) => f === name || f.endsWith("/" + name) || f.split(/[\\/]/).pop() === name) ?? name;
      try {
        const content = await window.orvyn.project.readFile(path);
        out.push({ path, content: content.slice(0, 8000) });
      } catch {
        // Mentioned path may not exist yet.
      }
    }
    return out;
  }

  function applyMention(path: string) {
    if (!mention) {
      setInput((prev) => `${prev.replace(/@([^\s@]*)$/, "")}@${path} `);
      return;
    }
    setInput((prev) => `${prev.slice(0, mention.start)}@${path} ${prev.slice(mention.end)}`);
    setMentionIndex(0);
  }

  async function send(text?: string, opts?: { forceImage?: boolean }) {
    let userMessage = (text ?? input).trim();
    if (!userMessage || streaming || agent.status === "running") return;

    const slash = userMessage.match(/^\/(plan|debug|ask|agent|multitask|image)\b\s*/i);
    let mode = chatMode;
    if (slash) {
      mode = slash[1].toLowerCase();
      userMessage = userMessage.slice(slash[0].length).trim();
      if (mode !== "image") setChatMode(mode);
    }
    if (!userMessage) return;

    const wantImage = Boolean(opts?.forceImage || forceImage || mode === "image" || looksLikeImageRequest(userMessage));
    if (wantImage) userMessage = stripImagePrefix(userMessage) || userMessage;
    setForceImage(false);

    const pending = attachments;
    const history = startUserTurn(userMessage, {
      mode: wantImage ? "image" : mode,
      attachments: pending.map((a) => ({ path: a.name, kind: a.kind })),
    });
    setInput("");
    setMentionIndex(0);
    setAttachments([]);

    if (wantImage) {
      appendAssistantDelta("Generating image…\n\n");
      await generateImage(userMessage, true);
      return;
    }

    if (mode === "agent" || mode === "plan" || mode === "debug" || mode === "multitask") {
      // @-mentions used to be parsed and rendered on this path and then
      // dropped: the agent received the bare "@src/auth.ts" text and none of
      // the file. Carrying them as file attachments reuses the plumbing the
      // adapters already fold into the prompt.
      const mentioned = await mentionedContext(userMessage);
      const ok = await agent.start({
        instruction: userMessage,
        mode,
        attachments: [
          ...pending,
          ...mentioned.map((f) => ({ kind: "file" as const, name: f.path, content: f.content })),
        ],
      });
      if (!ok) {
        appendAssistantDelta("Could not start that run. Open a folder, or check Connection settings.");
      }
      finishAssistantTurn();
      return;
    }

    const mentionedFiles = await mentionedContext(userMessage);
    const ws = new WebSocket(wsUrl("/ws/chat"));
    socketRef.current = ws;
    ws.onopen = () => {
      ws.send(
        JSON.stringify({
          task: "chat",
          history,
          userMessage,
          attachments: pending,
          context: {
            ...(currentFile ? { currentFile } : {}),
            ...(mentionedFiles.length ? { mentionedFiles } : {}),
            ...(workspace ? { projectRoot: workspace.root } : {}),
            useRag: useRag && Boolean(workspace?.root),
          },
        })
      );
    };
    ws.onmessage = (event) => {
      const chunk = JSON.parse(event.data);
      if (chunk.error) appendAssistantDelta(chunk.error);
      else appendAssistantDelta(chunk.delta ?? "");
      if (chunk.done) {
        finishAssistantTurn();
        ws.close();
      }
    };
    ws.onerror = () => {
      appendAssistantDelta("\n\nCould not reach the ORVYN backend. Check Connection settings.");
      finishAssistantTurn();
    };
  }

  async function generateImage(prompt: string, turnStarted = false) {
    const trimmed = stripImagePrefix(prompt);
    if (!trimmed) return;
    if (!turnStarted) {
      if (streaming) return;
      startUserTurn(trimmed, { mode: "image" });
      setInput("");
    }
    try {
      const markdown = await requestGeneratedImages(trimmed, workspace?.root, apiUrl, authHeaders);
      appendAssistantDelta(markdown);
    } catch (err: any) {
      appendAssistantDelta(`Image generation failed: ${err.message}`);
    } finally {
      finishAssistantTurn();
    }
  }

  const empty = messages.length === 0;
  const folderName =
    workspace?.kind === "folder" ? workspace.root.split(/[\\/]/).pop() : null;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", color: "#c9d1e0", minWidth: 0, overflow: "hidden", position: "relative" }}>
      {variant === "panel" && (
        <div
          style={{
            padding: "8px 12px",
            borderBottom: "1px solid #1c2330",
            fontSize: 13,
            fontWeight: 600,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 8,
            minWidth: 0,
            flexShrink: 0,
          }}
        >
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6, minWidth: 0, overflow: "hidden" }}>
            <img src={appIcon} alt="" width={16} height={16} style={{ borderRadius: 4, flexShrink: 0 }} />
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              Chat
              {currentFile ? ` · ${currentFile.path}` : folderName ? ` · ${folderName}` : " · no folder"}
            </span>
          </span>
          <span style={{ display: "inline-flex", gap: 6, flexShrink: 0, position: "relative" }}>
            <button onClick={() => setShowHistory((v) => !v)} style={ghostBtn()} title="Chat history">
              History
            </button>
            <button
              onClick={() => {
                setShowHistory(false);
                newChat();
              }}
              style={ghostBtn()}
            >
              New
            </button>
            {showHistory && (
              <ChatHistoryDropdown
                onOpen={(id) => {
                  openChatSession(id);
                  const runId = getActiveChat()?.runId;
                  if (runId) document.dispatchEvent(new CustomEvent("orvyn:open-run", { detail: runId }));
                  setShowHistory(false);
                }}
                onOpenRun={(runId, goal) => {
                  ensureChatForRun(goal, runId);
                  document.dispatchEvent(new CustomEvent("orvyn:open-run", { detail: runId }));
                  setShowHistory(false);
                }}
                onDelete={(id) => deleteChatSession(id)}
                onClose={() => setShowHistory(false)}
              />
            )}
          </span>
        </div>
      )}

      <div
        ref={scrollerRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 120);
        }}
        style={{ flex: 1, overflowY: "auto", overflowX: "hidden", padding: variant === "full" ? "32px 24px 12px" : 12, fontSize: 13, minWidth: 0, position: "relative" }}
      >
        {empty && variant === "full" ? (
          <EmptyHome
            recents={workspace?.recents ?? []}
            recentChats={listChatSessions().slice(0, 5)}
            onOpenChat={(id) => {
              openChatSession(id);
              const runId = getActiveChat()?.runId;
              if (runId) document.dispatchEvent(new CustomEvent("orvyn:open-run", { detail: runId }));
            }}
            onOpenFolder={onOpenFolder}
            onOpenFile={onOpenFile}
            onOpenRecent={onOpenRecent}
            onPrompt={(p) => send(p)}
          />
        ) : empty && listChatSessions().length > 0 ? (
          <div style={{ opacity: 0.7, lineHeight: 1.6, fontSize: 12.5 }}>
            <div style={{ opacity: 0.75, marginBottom: 10 }}>Hey — what are we working on?</div>
            <div style={{ fontSize: 11, opacity: 0.55, textTransform: "uppercase", letterSpacing: 0.6, marginBottom: 6 }}>
              Recent chats
            </div>
            {listChatSessions()
              .slice(0, 5)
              .map((s) => (
                <button
                  key={s.id}
                  onClick={() => {
                    openChatSession(s.id);
                    if (s.runId) document.dispatchEvent(new CustomEvent("orvyn:open-run", { detail: s.runId }));
                  }}
                  style={{
                    display: "block",
                    width: "100%",
                    textAlign: "left",
                    background: "transparent",
                    border: "1px solid #1c2330",
                    borderRadius: 8,
                    color: "#c9d1e0",
                    padding: "8px 10px",
                    marginBottom: 6,
                    cursor: "pointer",
                    fontSize: 12,
                  }}
                >
                  <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.title || "Untitled chat"}</div>
                  <div style={{ fontSize: 10.5, opacity: 0.5, marginTop: 2 }}>{new Date(s.updatedAt).toLocaleString()}</div>
                </button>
              ))}
          </div>
        ) : empty ? (
          <div style={{ opacity: 0.55, lineHeight: 1.5 }}>
            Hey — what are we working on?
          </div>
        ) : (
          messages.map((m, i) => {
            const isLiveAssistant = streaming && m.role === "assistant" && i === messages.length - 1;
            return (
              <div key={i} style={{ marginBottom: 16, maxWidth: variant === "full" ? 720 : "100%", marginLeft: variant === "full" ? "auto" : 0, marginRight: variant === "full" ? "auto" : 0 }}>
                <div style={{ opacity: 0.5, fontSize: 11, marginBottom: 4, letterSpacing: 0.4 }}>
                  {m.role === "user" ? "YOU" : "ORVYN"}
                </div>
                <div style={{ color: "var(--text)", lineHeight: 1.55 }}>
                  <MessageContent
                    content={m.content}
                    streaming={isLiveAssistant}
                    onApply={!isLiveAssistant && m.role === "assistant" ? onApplyCode : undefined}
                  />
                </div>
              </div>
            );
          })
        )}
        {(agent.events.length > 0 || agent.error) && (
          <div style={{ marginTop: 8, minWidth: 0 }}>
            {agent.error && (
              <div style={{ color: "var(--danger)", fontSize: 12, marginBottom: 8 }}>{agent.error}</div>
            )}
            <AgentActivityList events={agent.events} status={agent.status} onApprove={agent.approve} />
            <RunFooter events={agent.events} runId={agent.runId} finished={isRunFinished(agent.status)} />
          </div>
        )}
      </div>

      {!atBottom && (
        <button
          onClick={() => scrollerRef.current?.scrollTo({ top: scrollerRef.current.scrollHeight, behavior: "smooth" })}
          style={{
            position: "absolute",
            bottom: 150,
            right: 18,
            width: 30,
            height: 30,
            borderRadius: "50%",
            border: "1px solid var(--border-strong)",
            background: "var(--bg-elevated)",
            color: "var(--text-secondary)",
            cursor: "pointer",
            fontSize: 14,
            lineHeight: 1,
            boxShadow: "0 2px 8px rgba(0,0,0,0.35)",
          }}
          title="Scroll to bottom"
        >
          ↓
        </button>
      )}

      <div
        style={{
          padding: variant === "full" ? "8px 24px 24px" : 8,
          borderTop: variant === "full" ? "none" : "1px solid #1c2330",
          minWidth: 0,
          flexShrink: 0,
          position: "relative",
          overflow: "visible",
        }}
      >
        {live && (agent.status === "running" || agent.status === "awaiting_approval") && (
          <div
            style={{
              fontSize: 11.5,
              color: "var(--accent)",
              marginBottom: 6,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {live}
          </div>
        )}
        <div
          style={{
            maxWidth: variant === "full" ? 720 : "100%",
            margin: variant === "full" ? "0 auto" : 0,
            background: "#0f1420",
            border: "1px solid #1c2330",
            borderRadius: 10,
            padding: 8,
            position: "relative",
            minWidth: 0,
          }}
        >
          {mentionHits.length > 0 && (
            <div
              style={{
                position: "absolute",
                left: 8,
                right: 8,
                bottom: "100%",
                marginBottom: 6,
                background: "#11151F",
                border: "1px solid #262E42",
                borderRadius: 8,
                maxHeight: 220,
                overflowY: "auto",
                zIndex: 90,
              }}
            >
              {mentionHits.map((file, i) => (
                <button
                  key={file}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    applyMention(file);
                  }}
                  style={{
                    display: "block",
                    width: "100%",
                    textAlign: "left",
                    background: i === mentionIndex ? "#1E2536" : "transparent",
                    border: "none",
                    color: "#e6e9f0",
                    padding: "8px 10px",
                    fontSize: 12,
                    cursor: "pointer",
                  }}
                >
                  {file}
                </button>
              ))}
            </div>
          )}
          <AgentComposer
            compact
            hideModeDescription
            value={input}
            onChange={(v) => {
              setInput(v);
              setMentionIndex(0);
            }}
            onSubmit={() => void send()}
            mode={chatMode}
            onModeChange={setChatMode}
            attachments={attachments}
            onAttachmentsChange={setAttachments}
            disabled={streaming || agentBusy}
            busy={agentBusy}
            onStop={() => void agent.stop()}
            useRag={useRag}
            onUseRagChange={setUseRag}
            ragEnabled={Boolean(workspace?.root)}
            placeholder={
              forceImage
                ? "Describe the image to generate…"
                : empty
                  ? "Ask ORVYN…  @file for context, or “draw a logo of…”"
                  : "Follow up…  @ to mention a file"
            }
            onSkill={(id) => {
              if (id === "image") {
                setForceImage(true);
                if (input.trim()) void send(undefined, { forceImage: true });
              }
            }}
            onTextKeyDown={(e) => {
              if (mentionHits.length === 0) return;
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setMentionIndex((n) => Math.min(mentionHits.length - 1, n + 1));
                return true;
              }
              if (e.key === "ArrowUp") {
                e.preventDefault();
                setMentionIndex((n) => Math.max(0, n - 1));
                return true;
              }
              if (e.key === "Tab" || e.key === "Enter") {
                e.preventDefault();
                applyMention(mentionHits[mentionIndex] ?? mentionHits[0]);
                return true;
              }
            }}
          />
        </div>
        {variant === "full" && (
          <div style={{ maxWidth: 720, margin: "8px auto 0", fontSize: 11, opacity: 0.45, textAlign: "center" }}>
            Enter to send · Shift+Enter for a new line
            {workspace?.kind === "default" ? " · working in the built-in ORVYN workspace until you open a folder" : ""}
          </div>
        )}
      </div>
    </div>
  );
}

function ChatHistoryDropdown({
  onOpen,
  onOpenRun,
  onDelete,
  onClose,
}: {
  onOpen: (id: string) => void;
  onOpenRun: (runId: string, goal: string) => void;
  onDelete: (id: string) => void;
  onClose: () => void;
}) {
  const [, setTick] = useState(0);
  const [runs, setRuns] = useState<{ id: string; goal: string; createdAt: number }[]>([]);
  useEffect(() => subscribeChat(() => setTick((n) => n + 1)), []);
  useEffect(() => {
    let stop = false;
    fetch(apiUrl("/missions"), { headers: authHeaders() })
      .then((r) => (r.ok ? r.json() : { missions: [] }))
      .then((d) => {
        if (stop) return;
        const rows = Array.isArray(d.missions) ? d.missions : [];
        setRuns(rows.map((m: { runId?: string; id: string; goal?: string; createdAt?: number }) => ({
          id: String(m.runId || m.id),
          goal: String(m.goal || "Untitled"),
          createdAt: Number(m.createdAt || 0),
        })));
      })
      .catch(() => { if (!stop) setRuns([]); });
    return () => { stop = true; };
  }, []);
  const items = listChatSessions();
  const linked = new Set(items.map((s) => s.runId).filter((id): id is string => Boolean(id)));
  const past = runs.filter((r) => !linked.has(r.id));
  const activeId = getActiveChatId();

  return (
    <div
      style={{
        position: "absolute",
        top: "100%",
        right: 0,
        marginTop: 6,
        width: 300,
        maxHeight: 360,
        overflowY: "auto",
        background: "#11151F",
        border: "1px solid #262E42",
        borderRadius: 8,
        zIndex: 120,
        boxShadow: "0 8px 24px rgba(0,0,0,0.5)",
      }}
      onMouseLeave={onClose}
    >
      {items.length === 0 && past.length === 0 ? (
        <div style={{ padding: 12, fontSize: 12, opacity: 0.55 }}>No previous chats yet.</div>
      ) : (
        <>
        {past.map((r) => (
          <div
            key={r.id}
            style={{ padding: "8px 10px", borderBottom: "1px solid #1a2130", cursor: "pointer" }}
            onClick={() => onOpenRun(r.id, r.goal)}
          >
            <div style={{ fontSize: 12, color: "#e6e9f0", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.goal}</div>
            <div style={{ fontSize: 10.5, opacity: 0.5, marginTop: 2 }}>{r.createdAt ? new Date(r.createdAt).toLocaleString() : "Saved run"}</div>
          </div>
        ))}
        {items.map((s) => (
          <div
            key={s.id}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              padding: "8px 10px",
              background: s.id === activeId ? "#1E2536" : "transparent",
              borderBottom: "1px solid #1a2130",
              cursor: "pointer",
            }}
            onClick={() => onOpen(s.id)}
          >
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 12, color: "#e6e9f0", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {s.title || "Untitled chat"}
              </div>
              <div style={{ fontSize: 10.5, opacity: 0.5, marginTop: 2 }}>
                {new Date(s.updatedAt).toLocaleString()} · {s.count} messages
              </div>
            </div>
            <button
              title="Delete chat"
              onClick={(e) => {
                e.stopPropagation();
                onDelete(s.id);
              }}
              style={{
                background: "transparent",
                border: "none",
                color: "#7d8698",
                cursor: "pointer",
                fontSize: 13,
                padding: "2px 4px",
              }}
            >
              ×
            </button>
          </div>
        ))}
        </>
      )}
    </div>
  );
}

function EmptyHome({
  recents,
  recentChats = [],
  onOpenChat,
  onOpenFolder,
  onOpenFile,
  onOpenRecent,
  onPrompt,
}: {
  recents: string[];
  recentChats?: { id: string; title: string; updatedAt: number; count: number }[];
  onOpenChat?: (id: string) => void;
  onOpenFolder?: () => void;
  onOpenFile?: () => void;
  onOpenRecent?: (folder: string) => void;
  onPrompt: (text: string) => void;
}) {
  const prompts = [
    "Explain this codebase like I'm new to it",
    "Help me design an API for a new feature",
    "Write a Python script that…",
    "Review my approach before I write any code",
  ];

  return (
    <div style={{ maxWidth: 720, margin: "0 auto", paddingTop: 24 }}>
      <img src={lockup} alt="ORVYN" style={{ height: 56, width: "auto", display: "block", marginBottom: 12 }} />
      <div style={{ fontSize: 15, opacity: 0.65, marginBottom: 28, lineHeight: 1.5 }}>
        Chat first. Open a folder when you want Agent to touch files — you don't need one to start.
      </div>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 28 }}>
        <button onClick={onOpenFolder} style={actionBtn()}>
          Open folder
        </button>
        <button onClick={onOpenFile} style={actionBtn()}>
          Open file
        </button>
      </div>

      <div style={{ fontSize: 11, opacity: 0.5, textTransform: "uppercase", letterSpacing: 0.6, marginBottom: 8 }}>Try</div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 32 }}>
        {prompts.map((p) => (
          <button key={p} onClick={() => onPrompt(p)} style={chipBtn()}>
            {p}
          </button>
        ))}
      </div>

      {recentChats.length > 0 && (
        <>
          <div style={{ fontSize: 11, opacity: 0.5, textTransform: "uppercase", letterSpacing: 0.6, marginBottom: 8 }}>
            Recent chats
          </div>
          {recentChats.map((s) => (
            <button
              key={s.id}
              onClick={() => onOpenChat?.(s.id)}
              style={{
                display: "block",
                width: "100%",
                textAlign: "left",
                background: "transparent",
                border: "1px solid #1c2330",
                borderRadius: 8,
                color: "#c9d1e0",
                padding: "10px 12px",
                marginBottom: 8,
                cursor: "pointer",
              }}
            >
              <div style={{ fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {s.title || "Untitled chat"}
              </div>
              <div style={{ fontSize: 11, opacity: 0.5, marginTop: 2 }}>
                {new Date(s.updatedAt).toLocaleString()} · {s.count} messages
              </div>
            </button>
          ))}
          <div style={{ height: 16 }} />
        </>
      )}

      {recents.length > 0 && (
        <>
          <div style={{ fontSize: 11, opacity: 0.5, textTransform: "uppercase", letterSpacing: 0.6, marginBottom: 8 }}>
            Recent folders
          </div>
          {recents.map((folder) => (
            <button
              key={folder}
              onClick={() => onOpenRecent?.(folder)}
              style={{
                display: "block",
                width: "100%",
                textAlign: "left",
                background: "transparent",
                border: "1px solid #1c2330",
                borderRadius: 8,
                color: "#c9d1e0",
                padding: "10px 12px",
                marginBottom: 8,
                cursor: "pointer",
              }}
            >
              <div style={{ fontSize: 13 }}>{folder.split(/[\\/]/).pop()}</div>
              <div style={{ fontSize: 11, opacity: 0.5, marginTop: 2 }}>{folder}</div>
            </button>
          ))}
        </>
      )}
    </div>
  );
}

function parseMention(text: string): { query: string; start: number; end: number } | null {
  const at = text.lastIndexOf("@");
  if (at < 0) return null;
  const after = text.slice(at + 1);
  if (after.includes(" ") || after.includes("\n")) return null;
  return { query: after, start: at, end: text.length };
}

function ghostBtn(): React.CSSProperties {
  return {
    background: "transparent",
    border: "1px solid #2a3244",
    borderRadius: 6,
    color: "#c9d1e0",
    padding: "2px 8px",
    fontSize: 11,
    cursor: "pointer",
  };
}

function actionBtn(): React.CSSProperties {
  return {
    background: "#161b26",
    border: "1px solid #2a3244",
    borderRadius: 8,
    color: "#e6e9f0",
    padding: "8px 14px",
    cursor: "pointer",
    fontSize: 13,
  };
}

function chipBtn(): React.CSSProperties {
  return {
    background: "#0f1420",
    border: "1px solid #1c2330",
    borderRadius: 20,
    color: "#c9d1e0",
    padding: "6px 12px",
    cursor: "pointer",
    fontSize: 12,
  };
}
