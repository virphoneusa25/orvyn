import React, { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { wsUrl } from "../connection";
import {
  appendAssistantDelta,
  finishAssistantTurn,
  getChatMessages,
  isChatStreaming,
  newChat,
  startUserTurn,
  subscribeChat,
} from "../chatSession";
import { WorkspaceState } from "../orvyn-bridge";
import { MessageContent } from "./MessageContent";
import lockup from "../assets/logo-lockup.png";
import appIcon from "../assets/icon.png";

export function AIChatPanel({
  currentFile,
  workspace,
  variant = "panel",
  onOpenFolder,
  onOpenFile,
  onOpenRecent,
  onApplyCode,
}: {
  currentFile: { path: string; content: string } | null;
  workspace: WorkspaceState | null;
  variant?: "panel" | "full";
  onOpenFolder?: () => void;
  onOpenFile?: () => void;
  onOpenRecent?: (folder: string) => void;
  onApplyCode?: (code: string) => void;
}) {
  const [, setTick] = useState(0);
  const [input, setInput] = useState("");
  const [useRag, setUseRag] = useState(false);
  const socketRef = useRef<WebSocket | null>(null);
  const scrollerRef = useRef<HTMLDivElement | null>(null);

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
    scrollerRef.current?.scrollTo({ top: scrollerRef.current.scrollHeight });
  }, [messages, streaming]);

  function send(text?: string) {
    const userMessage = (text ?? input).trim();
    if (!userMessage || streaming) return;
    const history = startUserTurn(userMessage);
    setInput("");

    const ws = new WebSocket(wsUrl("/ws/chat"));
    socketRef.current = ws;
    ws.onopen = () => {
      ws.send(
        JSON.stringify({
          task: "chat",
          history,
          userMessage,
          context: {
            ...(currentFile ? { currentFile } : {}),
            ...(workspace ? { projectRoot: workspace.root } : {}),
            useRag: useRag && workspace?.kind === "folder",
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

  const empty = messages.length === 0;
  const folderName =
    workspace?.kind === "folder" ? workspace.root.split(/[\\/]/).pop() : null;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", color: "#c9d1e0" }}>
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
          }}
        >
          <span>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              <img src={appIcon} alt="" width={16} height={16} style={{ borderRadius: 4 }} />
              Chat
              {currentFile ? ` · ${currentFile.path}` : folderName ? ` · ${folderName}` : " · no folder"}
            </span>
          </span>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <button onClick={newChat} style={ghostBtn()}>
              New
            </button>
            <label style={{ fontSize: 11, fontWeight: 400, display: "flex", alignItems: "center", gap: 4, cursor: "pointer", opacity: 0.8 }}>
              <input
                type="checkbox"
                checked={useRag}
                disabled={workspace?.kind !== "folder"}
                onChange={(e) => setUseRag(e.target.checked)}
              />
              RAG
            </label>
          </div>
        </div>
      )}

      <div ref={scrollerRef} style={{ flex: 1, overflowY: "auto", padding: variant === "full" ? "32px 24px 12px" : 12, fontSize: 13 }}>
        {empty && variant === "full" ? (
          <EmptyHome
            recents={workspace?.recents ?? []}
            onOpenFolder={onOpenFolder}
            onOpenFile={onOpenFile}
            onOpenRecent={onOpenRecent}
            onPrompt={(p) => send(p)}
          />
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
      </div>

      <div
        style={{
          padding: variant === "full" ? "8px 24px 24px" : 8,
          borderTop: variant === "full" ? "none" : "1px solid #1c2330",
        }}
      >
        <div
          style={{
            maxWidth: variant === "full" ? 720 : "100%",
            margin: variant === "full" ? "0 auto" : 0,
            display: "flex",
            gap: 8,
            alignItems: "flex-end",
            background: "#0f1420",
            border: "1px solid #1c2330",
            borderRadius: 10,
            padding: 8,
          }}
        >
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            placeholder={empty ? "Ask ORVYN anything…" : "Follow up…"}
            rows={variant === "full" ? 3 : 2}
            style={{
              flex: 1,
              background: "transparent",
              border: "none",
              color: "#e6e9f0",
              padding: "6px 8px",
              fontSize: 13,
              resize: "none",
              outline: "none",
              fontFamily: "inherit",
            }}
          />
          <button
            onClick={() => send()}
            disabled={streaming || !input.trim()}
            style={{
              background: "#3b5bfd",
              border: "none",
              borderRadius: 8,
              color: "white",
              padding: "8px 14px",
              cursor: "pointer",
              opacity: streaming || !input.trim() ? 0.45 : 1,
            }}
          >
            Send
          </button>
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

function EmptyHome({
  recents,
  onOpenFolder,
  onOpenFile,
  onOpenRecent,
  onPrompt,
}: {
  recents: string[];
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
