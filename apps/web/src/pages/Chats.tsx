import { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";
import { ago } from "../lib/format";
import { navigate } from "../lib/router";
import { useStore } from "../lib/store";
import { useApi, type SessionRow } from "../lib/useApi";
import { ChatThread } from "../components/ChatThread";
import { Icon } from "../components/Icons";
import { Modal } from "../components/Bits";

export function Chats({ id }: { id?: string }) {
  const { toast } = useStore();
  const { data, reload } = useApi<{ sessions: SessionRow[] }>("/sessions");
  const [q, setQ] = useState("");
  const [renaming, setRenaming] = useState<SessionRow | null>(null);
  const [removing, setRemoving] = useState<SessionRow | null>(null);
  const [title, setTitle] = useState("");
  const sessions = useMemo(() => (data?.sessions ?? [])
    .filter((s) => !q || s.title.toLowerCase().includes(q.toLowerCase()) || s.lastMessage.toLowerCase().includes(q.toLowerCase()))
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt), [data, q]);
  const current = data?.sessions.find((s) => s.sessionId === id);

  // Keep the list fresh while a reply arrives.
  useEffect(() => { const t = window.setInterval(reload, 15_000); return () => window.clearInterval(t); }, [reload]);

  return (
    <div className="chats">
      <section className="card chats__list" aria-label="Conversations">
        <button className="btn btn--primary" onClick={() => navigate("/chats")} data-testid="new-chat"><Icon.plus size={18} /> New chat</button>
        <div className="search" style={{ height: 40, marginTop: 10, maxWidth: "none" }}>
          <Icon.search size={16} /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search chats" aria-label="Search chats" />
        </div>
        <div className="chats__scroll">
          {!sessions.length ? <div className="list__empty">{q ? "No chats match." : "No conversations yet."}</div> : null}
          {sessions.map((s) => (
            <div key={s.sessionId} className="row" style={{ gap: 2 }}>
              <button className={`chats__item${s.sessionId === id ? " is-on" : ""}`} onClick={() => navigate(`/chats/${s.sessionId}`)} data-testid="chat-item">
                <Icon.chat size={18} />
                <span style={{ minWidth: 0, flex: 1 }}>
                  <b>{s.title || "Conversation"}</b>
                  <span>{s.projectRoot ? "Desktop · " : ""}{ago(s.updatedAt)}</span>
                </span>
              </button>
              <button className="kebab" aria-label={`Rename ${s.title}`} onClick={() => { setRenaming(s); setTitle(s.title); }}><Icon.more size={16} /></button>
            </div>
          ))}
        </div>
      </section>
      <section className="card chat-pane">
        <div className="chat-pane__head">
          <h2>{current?.title ?? (id ? "Conversation" : "New chat")}</h2>
          {current ? <button className="btn btn--sm btn--ghost" onClick={() => setRemoving(current)} aria-label="Delete conversation"><Icon.trash size={16} /></button> : null}
        </div>
        <ChatThread
          sessionId={id ?? null}
          onSession={(sid) => { navigate(`/chats/${sid}`, { replace: true }); window.setTimeout(reload, 400); }}
          suggestions={["Summarize a document", "Write an email", "Explain some code", "Generate an image of a sunrise over mountains"]}
        />
      </section>
      {renaming ? (
        <Modal title="Rename conversation" onClose={() => setRenaming(null)}>
          <form onSubmit={async (e) => { e.preventDefault(); try { await api(`/sessions/${renaming.sessionId}`, { method: "PATCH", body: { title } }); reload(); setRenaming(null); } catch (err: any) { toast(err.message); } }}>
            <input className="input" style={{ width: "100%" }} value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
            <div className="modal__actions" style={{ marginTop: 14 }}>
              <button type="button" className="btn btn--danger" onClick={() => { setRemoving(renaming); setRenaming(null); }}>Delete</button>
              <button type="button" className="btn" onClick={() => setRenaming(null)}>Cancel</button>
              <button type="submit" className="btn btn--primary">Save</button>
            </div>
          </form>
        </Modal>
      ) : null}
      {removing ? (
        <Modal title="Delete this conversation?" onClose={() => setRemoving(null)}>
          <p className="muted">“{removing.title}” and its messages are removed for good. Files it produced stay in Files.</p>
          <div className="modal__actions">
            <button className="btn" onClick={() => setRemoving(null)}>Cancel</button>
            <button className="btn btn--danger" onClick={async () => { try { await api(`/sessions/${removing.sessionId}`, { method: "DELETE" }); if (removing.sessionId === id) navigate("/chats"); reload(); } catch (err: any) { toast(err.message); } setRemoving(null); }}>Delete</button>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}
