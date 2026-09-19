// apps/desktop/src/renderer/components/ChatHistoryPanel.tsx
//
// The "Chats" nav view: every saved chat session, newest first. The store
// already persists sessions; this panel just surfaces them as the primary
// navigation surface instead of a dropdown inside the chat header.
import React, { useEffect, useState } from "react";
import {
  listChatSessions,
  openChatSession,
  deleteChatSession,
  subscribeChat,
  getActiveChatId,
} from "../chatSession";
import { IconChat, IconClose, IconPlus } from "./Icons";

export function ChatHistoryPanel({ onOpenChat, onNewChat }: { onOpenChat: () => void; onNewChat: () => void }) {
  const [, setTick] = useState(0);
  const sessions = listChatSessions();
  const activeId = getActiveChatId();

  useEffect(() => subscribeChat(() => setTick((t) => t + 1)), []);

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", minWidth: 0 }}>
      <div style={{ padding: "14px 16px 10px", borderBottom: "1px solid var(--border)" }}>
        <div style={{ fontSize: 13, fontWeight: 600, display: "flex", alignItems: "center", gap: 8 }}>
          <IconChat size={15} /> Chats
        </div>
        <button
          onClick={() => {
            onNewChat();
            onOpenChat();
          }}
          style={{
            marginTop: 10,
            width: "100%",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 6,
            background: "var(--accent)",
            border: "none",
            borderRadius: 6,
            color: "var(--accent-fg)",
            padding: "7px 0",
            fontSize: 12.5,
            cursor: "pointer",
          }}
        >
          <IconPlus size={13} /> New chat
        </button>
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: 8 }}>
        {sessions.length === 0 && (
          <div style={{ fontSize: 12, color: "var(--text-muted)", padding: "12px 8px" }}>
            No chats yet. Ask something in the Chat panel and it will appear here.
          </div>
        )}
        {sessions.map((s) => {
          const active = s.id === activeId;
          return (
            <div
              key={s.id}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                borderRadius: 6,
                padding: "8px 8px 8px 10px",
                marginBottom: 4,
                cursor: "pointer",
                background: active ? "var(--bg-active)" : "transparent",
                border: `1px solid ${active ? "var(--border-strong)" : "transparent"}`,
              }}
              onClick={() => {
                openChatSession(s.id);
                onOpenChat();
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div
                  style={{
                    fontSize: 12.5,
                    color: active ? "var(--text)" : "var(--text-secondary)",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {s.title || "(untitled)"}
                </div>
                <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2 }}>
                  {s.count} message{s.count === 1 ? "" : "s"} · {new Date(s.updatedAt).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                </div>
              </div>
              <button
                title="Delete chat"
                onClick={(e) => {
                  e.stopPropagation();
                  deleteChatSession(s.id);
                }}
                style={{
                  background: "transparent",
                  border: "none",
                  color: "var(--text-muted)",
                  cursor: "pointer",
                  padding: 4,
                  display: "flex",
                  flexShrink: 0,
                }}
              >
                <IconClose size={13} />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
