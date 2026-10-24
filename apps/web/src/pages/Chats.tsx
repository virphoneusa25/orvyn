import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";
import { ago } from "../lib/format";
import { navigate, useLocation } from "../lib/router";
import { useStore } from "../lib/store";
import { signal, useSignal } from "../lib/events";
import { useApi, type Project, type SessionRow } from "../lib/useApi";
import { ChatThread } from "../components/ChatThread";
import { Icon } from "../components/Icons";
import { Modal } from "../components/Bits";
import { ActionMenu } from "../components/Menu";

const DAY = 86_400_000;

function groupOf(s: SessionRow, now = Date.now()): string {
  if (s.pinned) return "Pinned";
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const t = s.updatedAt;
  if (t >= start.getTime()) return "Today";
  if (t >= start.getTime() - DAY) return "Yesterday";
  if (t >= now - 7 * DAY) return "Previous 7 days";
  if (t >= now - 30 * DAY) return "Previous 30 days";
  return "Older";
}
const ORDER = ["Pinned", "Today", "Yesterday", "Previous 7 days", "Previous 30 days", "Older"];

/** Pin, rename, move, share and delete — the same actions from the list and the open chat. */
export function useChatActions(reload: () => void, openId?: string) {
  const { toast } = useStore();
  const [renaming, setRenaming] = useState<SessionRow | null>(null);
  const [removing, setRemoving] = useState<SessionRow | null>(null);
  const [moving, setMoving] = useState<SessionRow | null>(null);
  const [sharing, setSharing] = useState<SessionRow | null>(null);
  const done = () => { reload(); signal("sessions"); };
  const pin = async (s: SessionRow) => { try { await api(`/sessions/${s.sessionId}`, { method: "PATCH", body: { pinned: !s.pinned } }); done(); } catch (err: any) { toast(err.message); } };
  const items = (s: SessionRow) => [
    { label: s.pinned ? "Unpin" : "Pin", icon: <Icon.pin size={15} />, onClick: () => void pin(s), testid: "chat-pin" },
    { label: "Rename", icon: <Icon.edit size={15} />, onClick: () => setRenaming(s), testid: "chat-rename" },
    { label: "Move to project", icon: <Icon.folder size={15} />, onClick: () => setMoving(s), testid: "chat-move", hidden: Boolean(s.projectRoot) },
    { label: "Share", icon: <Icon.share size={15} />, onClick: () => setSharing(s), testid: "chat-share" },
    "sep" as const,
    { label: "Delete", icon: <Icon.trash size={15} />, onClick: () => setRemoving(s), danger: true, testid: "chat-delete" },
  ];
  const modals = (
    <>
      {renaming ? <RenameModal s={renaming} onClose={() => setRenaming(null)} onDone={done} /> : null}
      {moving ? <MoveModal s={moving} onClose={() => setMoving(null)} onDone={done} /> : null}
      {sharing ? <ShareModal s={sharing} onClose={() => setSharing(null)} /> : null}
      {removing ? (
        <Modal title="Delete this conversation?" onClose={() => setRemoving(null)}>
          <p className="muted">“{removing.title}” and its messages are removed for good. Files it produced stay in Files.</p>
          <div className="modal__actions">
            <button className="btn" onClick={() => setRemoving(null)}>Cancel</button>
            <button className="btn btn--danger" data-testid="confirm-delete" onClick={async () => { try { await api(`/sessions/${removing.sessionId}`, { method: "DELETE" }); if (removing.sessionId === openId) navigate("/chats"); done(); } catch (err: any) { toast(err.message); } setRemoving(null); }}>Delete</button>
          </div>
        </Modal>
      ) : null}
    </>
  );
  return { items, modals, pin, rename: setRenaming, share: setSharing };
}

export function Chats({ id }: { id?: string }) {
  const { query } = useLocation();
  const { data, reload, loading } = useApi<{ sessions: SessionRow[] }>("/sessions");
  const projects = useApi<{ projects: Project[] }>("/projects");
  const [q, setQ] = useState("");
  const [recentCollapsed, setRecentCollapsed] = useState(() => {
    try { return localStorage.getItem("orvyn.recentChats.collapsed") === "true"; } catch { return false; }
  });
  const toggleRecent = () => setRecentCollapsed(previous => {
    const next = !previous;
    try { localStorage.setItem("orvyn.recentChats.collapsed", String(next)); } catch { /* Keep the control usable when storage is unavailable. */ }
    return next;
  });
  const [ask] = useState(() => query.get("q") ?? "");
  const composing = query.get("new") === "1";
  const actions = useChatActions(reload, id);
  useSignal("sessions", reload);
  useEffect(() => { if (ask) navigate("/chats", { replace: true }); }, [ask]);

  const projectName = useCallback((pid: string | null) => (pid ? projects.data?.projects.find((p) => p.id === pid)?.name : undefined), [projects.data]);
  const sessions = useMemo(() => (data?.sessions ?? [])
    .filter((s) => !q || s.title.toLowerCase().includes(q.toLowerCase()) || (s.lastMessage ?? "").toLowerCase().includes(q.toLowerCase()))
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt), [data, q]);
  const groups = useMemo(() => {
    const m = new Map<string, SessionRow[]>();
    for (const s of sessions) { const g = groupOf(s); m.set(g, [...(m.get(g) ?? []), s]); }
    return ORDER.filter((g) => m.has(g)).map((g) => [g, m.get(g)!] as const);
  }, [sessions]);
  const current = data?.sessions.find((s) => s.sessionId === id);

  return (
    <div className={`chats${id || ask || composing ? " chats--thread" : ""}${recentCollapsed ? " chats--recent-collapsed" : ""}`}>
      <section id="recent-chats-panel" className="chats__list" aria-label="Recent chats">
        <div className="chats__list-head"><b>Recent chats</b><button className="iconbtn chats__collapse" onClick={toggleRecent} aria-label="Collapse recent chats" title="Collapse recent chats" aria-expanded={!recentCollapsed} aria-controls="recent-chats-panel"><Icon.back size={18} /></button></div>
        <div className="chats__tools">
          <label className="search">
            <Icon.search size={15} /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search chats" aria-label="Search chats" />
          </label>
          <button className="btn btn--icon" onClick={() => navigate("/chats?new=1")} data-testid="new-chat" aria-label="New chat" title="New chat"><Icon.edit size={16} /></button>
        </div>
        <div className="chats__scroll">
          {loading && !data ? <div className="list__empty" style={{ padding: 12 }}>Loading…</div> : null}
          {data && !sessions.length ? <div className="list__empty" style={{ padding: 12 }}>{q ? "No chats match." : "No conversations yet. Start one on the right."}</div> : null}
          {groups.map(([g, rows]) => (
            <div key={g}>
              <div className="chats__group">{g}</div>
              {rows.map((s) => (
                <div key={s.sessionId} className={`chats__row${s.sessionId === id ? " is-on" : ""}`}>
                  <button className="chats__item" onClick={() => navigate(s.projectId && !s.projectRoot ? `/projects/${s.projectId}/chats/${s.sessionId}` : `/chats/${s.sessionId}`)} data-testid="chat-item" title={s.title}>
                    {s.pinned ? <Icon.pin size={14} /> : s.projectRoot ? <Icon.monitor size={14} /> : s.projectId ? <Icon.folder size={14} /> : <Icon.chat size={14} />}
                    <span>
                      <b>{s.title || "Conversation"}</b>
                      <span>{s.projectRoot ? "Desktop · " : projectName(s.projectId) ? `${projectName(s.projectId)} · ` : ""}{ago(s.updatedAt)}</span>
                    </span>
                  </button>
                  <ActionMenu label={`Actions for ${s.title}`} trigger={<Icon.more size={16} />} items={actions.items(s)} />
                </div>
              ))}
            </div>
          ))}
        </div>
      </section>
      <section className="chat-pane">
        <div className="chat-pane__head">
          {recentCollapsed && <button className="btn btn--sm btn--ghost chats__reopen" onClick={toggleRecent} aria-label="Open recent chats" title="Open recent chats" aria-expanded={false} aria-controls="recent-chats-panel"><Icon.chat size={16} /> Recent chats</button>}
          <button className="iconbtn mobile-only" onClick={() => navigate("/chats")} aria-label="Back to conversations"><Icon.back size={19} /></button>
          <h2 title={current?.title}>{current?.title ?? (id ? "Conversation" : "New chat")}</h2>
          {current ? (
            <>
              <button className="btn btn--sm btn--ghost" onClick={() => actions.share(current)} data-testid="head-share"><Icon.share size={15} /> Share</button>
              <button className="btn btn--sm btn--ghost btn--icon" onClick={() => void actions.pin(current)} aria-label={current.pinned ? "Unpin" : "Pin"} title={current.pinned ? "Unpin" : "Pin"}><Icon.pin size={15} /></button>
              <ActionMenu label="Conversation actions" trigger={<Icon.more size={16} />} items={actions.items(current)} />
            </>
          ) : null}
        </div>
        <ChatThread
          sessionId={id ?? null}
          initialPrompt={ask || undefined}
          onSession={(sid) => { navigate(`/chats/${sid}`, { replace: true }); window.setTimeout(reload, 400); }}
        />
      </section>
      {actions.modals}
    </div>
  );
}

function RenameModal({ s, onClose, onDone }: { s: SessionRow; onClose: () => void; onDone: () => void }) {
  const { toast } = useStore();
  const [title, setTitle] = useState(s.title);
  return (
    <Modal title="Rename conversation" onClose={onClose}>
      <form onSubmit={async (e) => { e.preventDefault(); try { await api(`/sessions/${s.sessionId}`, { method: "PATCH", body: { title } }); onDone(); onClose(); } catch (err: any) { toast(err.message); } }}>
        <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus aria-label="Title" data-testid="rename-input" />
        <div className="modal__actions">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn--primary" data-testid="rename-save">Save</button>
        </div>
      </form>
    </Modal>
  );
}

function MoveModal({ s, onClose, onDone }: { s: SessionRow; onClose: () => void; onDone: () => void }) {
  const { toast } = useStore();
  const projects = useApi<{ projects: Project[] }>("/projects");
  const [to, setTo] = useState<string>(s.projectId ?? "");
  return (
    <Modal title="Move to project" onClose={onClose}>
      <p className="muted" style={{ marginTop: 0 }}>Chats in a project share its files and context.</p>
      <div className="list" style={{ maxHeight: 300, overflow: "auto" }}>
        <label className="list__row check"><input type="radio" name="proj" checked={to === ""} onChange={() => setTo("")} /> <span className="list__main"><b>No project</b></span></label>
        {(projects.data?.projects ?? []).map((p) => (
          <label key={p.id} className="list__row check"><input type="radio" name="proj" checked={to === p.id} onChange={() => setTo(p.id)} /> <Icon.folder size={16} /><span className="list__main"><b>{p.name}</b></span></label>
        ))}
      </div>
      <div className="modal__actions">
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn--primary" data-testid="move-save" onClick={async () => { try { await api(`/sessions/${s.sessionId}`, { method: "PATCH", body: { projectId: to || null } }); onDone(); onClose(); } catch (err: any) { toast(err.message); } }}>Move</button>
      </div>
    </Modal>
  );
}

function ShareModal({ s, onClose }: { s: SessionRow; onClose: () => void }) {
  const { toast } = useStore();
  const existing = useApi<{ share: { id: string; createdAt: number } | null }>(`/sessions/${s.sessionId}/share`);
  const [url, setUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const create = async () => {
    setBusy(true);
    try { const r = await api<{ url: string }>(`/sessions/${s.sessionId}/share`, { method: "POST", body: {} }); setUrl(r.url); existing.reload(); } catch (err: any) { toast(err.message); } finally { setBusy(false); }
  };
  const off = async () => { await api(`/sessions/${s.sessionId}/share`, { method: "DELETE" }).catch(() => undefined); setUrl(null); existing.reload(); toast("Sharing is off. The old link no longer works."); };
  const live = Boolean(url || existing.data?.share);
  return (
    <Modal title="Share conversation" onClose={onClose}>
      <p className="muted" style={{ marginTop: 0 }}>Anyone with the link can read this conversation's messages. Files, attachments and your account details are never shared. New messages you send later are included.</p>
      {url ? (
        <div className="secret" data-testid="share-url"><code>{url}</code><button className="btn btn--sm" onClick={() => { void navigator.clipboard?.writeText(url); toast("Link copied."); }}><Icon.copy size={14} /> Copy</button></div>
      ) : existing.data?.share ? (
        <div className="notice notice--violet">A share link is on (made {ago(existing.data.share.createdAt)}). For security the full link is only shown when it's made — create a new link to copy it again (the old one stops working).</div>
      ) : null}
      <div className="modal__actions">
        {live ? <button className="btn btn--danger" onClick={() => void off()} data-testid="share-off">Turn off sharing</button> : null}
        <button className="btn" onClick={onClose}>Close</button>
        {!url ? <button className="btn btn--primary" disabled={busy} onClick={() => void create()} data-testid="share-create"><Icon.link size={15} /> {existing.data?.share ? "Create new link" : "Create link"}</button> : null}
      </div>
    </Modal>
  );
}
