// apps/desktop/src/renderer/components/ChatsWorkspace.tsx
//
// The Chats workspace: a real center page for conversation history.
// Filters (Recent/Active/Pinned/Archived), search, conversation rows with
// real metadata, overflow menu for pin/archive/rename/delete. Opening a
// conversation resumes it in the active ORION workspace.

import React, { useEffect, useMemo, useState } from "react";
import { apiUrl, authHeaders } from "../connection";
import {
  listChatSummaries,
  searchChats,
  pinChatSession,
  archiveChatSession,
  renameChatSession,
  deleteChatSession,
  subscribeChat,
  type ConversationSummary,
} from "../chatSession";
import { syncSessions } from "../sessionsApi";

function relTime(ts: number): string {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

type Filter = "recent" | "pinned" | "archived" | "all";

export function ChatsWorkspace({ onOpenChat, onOpenRun }: { onOpenChat: (id: string) => void; onOpenRun?: (runId: string, goal?: string) => void }) {
  const [tick, setTick] = useState(0);
  const [filter, setFilter] = useState<Filter>("recent");
  const [query, setQuery] = useState("");
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [runs, setRuns] = useState<{ id: string; goal: string; status: string; createdAt: number }[]>([]);

  useEffect(() => {
    let stop = false;
    fetch(apiUrl("/missions"), { headers: authHeaders() })
      .then((r) => (r.ok ? r.json() : { missions: [] }))
      .then((d) => {
        if (stop) return;
        const rows = Array.isArray(d.missions) ? d.missions : [];
        setRuns(rows.map((m: { runId?: string; id: string; goal?: string; status?: string; createdAt?: number }) => ({
          id: String(m.runId || m.id),
          goal: String(m.goal || "Untitled"),
          status: String(m.status || ""),
          createdAt: Number(m.createdAt || 0),
        })));
      })
      .catch(() => { if (!stop) setRuns([]); });
    return () => { stop = true; };
  }, [tick]);

  React.useEffect(() => subscribeChat(() => setTick((t) => t + 1)), []);
  // The backend's sessions are the list; the local file is only a cache.
  React.useEffect(() => { void syncSessions(); }, []);

  // Recompute on every tick (the subscription's rerender signal) — NOT on
  // listChatSummaries() (which would create a new dep-array value every
  // render). tick changes when: history loads, a message completes, a chat
  // is created/renamed/pinned/archived/deleted.
  const all = useMemo(() => listChatSummaries(), [tick]);
  const filtered = useMemo(() => {
    let list = query.trim() ? searchChats(query) : all;
    switch (filter) {
      case "recent":
        list = list.filter((c) => !c.archived);
        break;
      case "pinned":
        list = list.filter((c) => c.pinned && !c.archived);
        break;
      case "archived":
        list = list.filter((c) => c.archived);
        break;
      case "all":
        break;
    }
    // Pinned sort above normal in every filter
    return [...list].sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      return b.updatedAt - a.updatedAt;
    });
  }, [all, filter, query]);

  const pastRuns = useMemo(() => {
    if (filter === "pinned" || filter === "archived") return [];
    const linked = new Set(all.map((c) => c.runId).filter((id): id is string => Boolean(id)));
    const q = query.trim().toLowerCase();
    return runs.filter((r) => !linked.has(r.id) && (!q || r.goal.toLowerCase().includes(q) || r.status.toLowerCase().includes(q)));
  }, [runs, all, filter, query]);

  function handleOpen(id: string) {
    onOpenChat(id);
  }

  function handleDelete(id: string) {
    const chat = all.find((c) => c.id === id);
    if (chat?.runId || chat?.missionId) {
      // Chat has a linked mission — warn
      if (!confirm(`This chat is linked to a mission/run. Deleting the chat will NOT delete the mission. Continue?`)) {
        setConfirmDelete(null);
        return;
      }
    } else if (!confirm("Delete this conversation? This cannot be undone.")) {
      setConfirmDelete(null);
      return;
    }
    deleteChatSession(id);
    setConfirmDelete(null);
  }

  const FILTERS: { id: Filter; label: string }[] = [
    { id: "recent", label: "Recent" },
    { id: "pinned", label: "Pinned" },
    { id: "archived", label: "Archived" },
    { id: "all", label: "All" },
  ];

  return (
    <div style={{ height: "100%", overflowY: "auto", padding: "20px 24px", minWidth: 0, background: "var(--ov-bg, var(--orvyn-bg-app))" }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 16 }}>
        <h1 style={{ fontSize: 20, fontWeight: 700, color: "var(--ov-text, var(--orvyn-text))", margin: 0 }}>Chats</h1>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search conversations..."
          style={{
            flex: 1, maxWidth: 380, background: "var(--ov-panel, var(--orvyn-surface-2))",
            border: "1px solid var(--ov-line, var(--orvyn-border))", borderRadius: 8,
            color: "var(--ov-text, var(--orvyn-text))", fontSize: 12.5, padding: "7px 12px", outline: "none",
          }}
        />
      </div>

      {/* Filters */}
      <div style={{ display: "flex", gap: 6, marginBottom: 14 }}>
        {FILTERS.map((f) => (
          <button
            key={f.id}
            onClick={() => setFilter(f.id)}
            style={{
              background: filter === f.id ? "var(--ov-chip-on, rgba(108,92,255,0.2))" : "transparent",
              border: `1px solid ${filter === f.id ? "var(--orvyn-purple)" : "var(--ov-line, var(--orvyn-border))"}`,
              borderRadius: 999, color: filter === f.id ? "var(--orvyn-text)" : "var(--orvyn-text-muted)",
              fontSize: 11, fontWeight: 600, padding: "5px 14px", cursor: "pointer",
            }}
          >
            {f.label}
          </button>
        ))}
        <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--orvyn-text-muted)", alignSelf: "center" }}>
          {filtered.length + pastRuns.length} conversation{filtered.length + pastRuns.length === 1 ? "" : "s"}
        </span>
      </div>

      {/* Conversation rows */}
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {filtered.map((c) => (
          <ChatRow
            key={c.id}
            chat={c}
            onOpen={handleOpen}
            onPin={(id, p) => pinChatSession(id, p)}
            onArchive={(id, a) => archiveChatSession(id, a)}
            onRenameStart={(id, title) => { setRenaming(id); setRenameValue(title); }}
            onRenameConfirm={(id) => { renameChatSession(id, renameValue); setRenaming(null); }}
            onRenameCancel={() => setRenaming(null)}
            renaming={renaming === c.id}
            renameValue={renameValue}
            onRenameValueChange={setRenameValue}
            menuOpen={menuFor === c.id}
            onMenuToggle={(id) => setMenuFor(menuFor === id ? null : id)}
            onDelete={(id) => handleDelete(id)}
            confirmDeleteId={confirmDelete}
          />
        ))}
        {pastRuns.map((r) => (
          <button
            key={r.id}
            type="button"
            onClick={() => onOpenRun?.(r.id, r.goal)}
            style={{
              textAlign: "left",
              background: "var(--ov-panel, var(--orvyn-surface-2))",
              border: "1px solid var(--ov-line, var(--orvyn-border-soft))",
              borderRadius: 10, padding: "12px 14px", cursor: "pointer",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ fontSize: 13.5, fontWeight: 600, color: "var(--orvyn-text)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {r.goal}
              </span>
              <span style={{ fontSize: 10, color: "var(--orvyn-text-muted)", flexShrink: 0 }}>{relTime(r.createdAt)}</span>
            </div>
            <div style={{ marginTop: 4, fontSize: 10, letterSpacing: 0.4, color: "var(--orvyn-purple-hi)" }}>{r.status}</div>
          </button>
        ))}
        {filtered.length === 0 && pastRuns.length === 0 && (
          <div style={{ padding: "40px 0", textAlign: "center", fontSize: 12.5, color: "var(--orvyn-text-muted)" }}>
            {query ? `No conversations matching "${query}"` : `No ${filter === "recent" ? "" : filter} conversations yet.`}
          </div>
        )}
      </div>
    </div>
  );
}

function ChatRow({
  chat, onOpen, onPin, onArchive, onRenameStart, onRenameConfirm, onRenameCancel,
  renaming, renameValue, onRenameValueChange, menuOpen, onMenuToggle, onDelete, confirmDeleteId,
}: {
  chat: ConversationSummary;
  onOpen: (id: string) => void;
  onPin: (id: string, pinned: boolean) => void;
  onArchive: (id: string, archived: boolean) => void;
  onRenameStart: (id: string, title: string) => void;
  onRenameConfirm: (id: string) => void;
  onRenameCancel: () => void;
  renaming: boolean;
  renameValue: string;
  onRenameValueChange: (v: string) => void;
  menuOpen: boolean;
  onMenuToggle: (id: string) => void;
  onDelete: (id: string) => void;
  confirmDeleteId: string | null;
}) {
  return (
    <div
      style={{
        background: "var(--ov-panel, var(--orvyn-surface-2))",
        border: "1px solid var(--ov-line, var(--orvyn-border-soft))",
        borderRadius: 10, padding: "12px 14px", cursor: "pointer", position: "relative",
      }}
      data-testid="chat-row"
      data-chat-id={chat.id}
      data-session-id={chat.sessionId ?? ""}
      data-run-id={chat.runId ?? ""}
      onClick={() => !renaming && onOpen(chat.id)}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        {chat.pinned && <span style={{ color: "var(--orvyn-purple-hi)", fontSize: 12 }}>★</span>}
        {renaming ? (
          <input
            value={renameValue}
            onChange={(e) => onRenameValueChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") onRenameConfirm(chat.id);
              if (e.key === "Escape") onRenameCancel();
            }}
            onClick={(e) => e.stopPropagation()}
            autoFocus
            style={{
              flex: 1, background: "var(--orvyn-bg)", border: "1px solid var(--orvyn-purple)",
              borderRadius: 6, color: "var(--orvyn-text)", fontSize: 13, padding: "4px 8px", outline: "none",
            }}
          />
        ) : (
          <span style={{ fontSize: 13.5, fontWeight: 600, color: "var(--orvyn-text)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {chat.title}
          </span>
        )}
        <span style={{ fontSize: 10, color: "var(--orvyn-text-muted)", flexShrink: 0 }}>{relTime(chat.updatedAt)}</span>
        <button
          onClick={(e) => { e.stopPropagation(); onMenuToggle(chat.id); }}
          style={{
            background: "transparent", border: "none", color: "var(--orvyn-text-muted)",
            fontSize: 14, cursor: "pointer", padding: "2px 6px", flexShrink: 0,
          }}
        >
          ⋯
        </button>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 4 }}>
        <span style={{ fontSize: 11, color: "var(--orvyn-text-muted)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {chat.preview || "(no messages)"}
        </span>
        <span style={{ fontSize: 10, color: "var(--orvyn-text-muted)", flexShrink: 0 }}>{chat.messageCount} msg</span>
        {chat.projectName && (
          <span style={{ fontSize: 10, color: "var(--orvyn-cyan)", flexShrink: 0, fontFamily: "var(--font-mono)" }}>{chat.projectName}</span>
        )}
        {chat.runId && (
          <span title={`Session ${chat.sessionId ?? "—"} · run ${chat.runId}`} style={{ fontSize: 9, color: "var(--orvyn-purple-hi)", flexShrink: 0, border: "1px solid rgba(108,92,255,0.3)", borderRadius: 3, padding: "1px 5px" }}>
            {(chat.runCount ?? 1) > 1 ? `${chat.runCount} RUNS` : "RUN"}
          </span>
        )}
        {chat.archived && (
          <span style={{ fontSize: 9, color: "var(--orvyn-yellow)", flexShrink: 0 }}>ARCHIVED</span>
        )}
      </div>

      {/* Overflow menu */}
      {menuOpen && (
        <div
          onClick={(e) => e.stopPropagation()}
          style={{
            position: "absolute", right: 8, top: 36, zIndex: 10,
            background: "var(--ov-panel2, var(--orvyn-surface-2))",
            border: "1px solid var(--ov-line, var(--orvyn-border))",
            borderRadius: 8, boxShadow: "0 8px 24px rgba(0,0,0,0.4)", padding: 4, minWidth: 140,
          }}
        >
          <MenuItem label={chat.pinned ? "Unpin" : "Pin"} onClick={() => { onPin(chat.id, !chat.pinned); onMenuToggle(chat.id); }} />
          <MenuItem label={chat.archived ? "Unarchive" : "Archive"} onClick={() => { onArchive(chat.id, !chat.archived); onMenuToggle(chat.id); }} />
          <MenuItem label="Rename" onClick={() => { onRenameStart(chat.id, chat.title); onMenuToggle(chat.id); }} />
          <MenuItem label="Delete" danger onClick={() => { onDelete(chat.id); onMenuToggle(chat.id); }} />
        </div>
      )}
    </div>
  );
}

function MenuItem({ label, onClick, danger }: { label: string; onClick: () => void; danger?: boolean }) {
  return (
    <button
      onClick={onClick}
      style={{
        display: "block", width: "100%", textAlign: "left",
        background: "transparent", border: "none", borderRadius: 5,
        color: danger ? "var(--orvyn-red, #F25F75)" : "var(--orvyn-text-secondary)",
        fontSize: 11.5, padding: "6px 10px", cursor: "pointer",
      }}
    >
      {label}
    </button>
  );
}
