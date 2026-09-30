import { useCallback, useEffect, useState } from "react";
import { api, setToken } from "../lib/api";
import { ago } from "../lib/format";
import { navigate } from "../lib/router";
import { useStore } from "../lib/store";
import { signal, useSignal } from "../lib/events";
import { Icon } from "./Icons";
import { useDismiss } from "./Menu";

export interface Note { id: string; kind: "warning" | "info" | "danger"; title: string; body: string; href?: string; at: number; inviteId?: string }

/** The bell: real account signals (low credits, usage windows, payment problems, team invitations). */
export function Notifications() {
  const { refresh, toast, me } = useStore();
  const [open, setOpen] = useState(false);
  const [notes, setNotes] = useState<Note[]>([]);
  const ref = useDismiss<HTMLDivElement>(open, () => setOpen(false));
  const load = useCallback(() => { api<{ notifications: Note[] }>("/account/notifications").then((r) => setNotes(r.notifications)).catch(() => undefined); }, []);
  useEffect(() => { load(); const t = window.setInterval(load, 90_000); return () => window.clearInterval(t); }, [load]);
  useSignal("notifications", load);

  const accept = async (n: Note) => {
    try {
      const r = await api<{ organization: { id: string; name: string } }>(`/account/invites/${n.inviteId}/accept`, { method: "POST", body: {} });
      const sw = await api<{ token: string }>("/auth/switch-organization", { method: "POST", body: { organizationId: r.organization.id } });
      setToken(sw.token);
      await refresh();
      signal("sessions"); signal("projects"); signal("files");
      setOpen(false); load(); navigate("/");
      toast(`You joined ${r.organization.name}.`);
    } catch (err: any) { toast(err.message); }
  };
  const decline = async (n: Note) => { await api(`/account/invites/${n.inviteId}/decline`, { method: "POST", body: {} }).catch(() => undefined); load(); };

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button className="iconbtn" aria-label={`Notifications${notes.length ? ` (${notes.length})` : ""}`} aria-haspopup="dialog" aria-expanded={open} onClick={() => { setOpen((v) => !v); if (!open) load(); }} data-testid="bell">
        <Icon.bell size={19} />
        {notes.length ? <span className="iconbtn__dot" data-testid="bell-dot" /> : null}
      </button>
      {open ? (
        <div className="pop" role="dialog" aria-label="Notifications" data-testid="notifications">
          <div className="pop__head"><b>Notifications</b><span className="muted" style={{ fontSize: 12 }}>{me?.principal.organizationName}</span></div>
          {!notes.length ? <div className="pop__empty">You're all caught up.</div> : notes.map((n) => (
            <div key={n.id} className={`note note--${n.kind}`} data-testid="note">
              <span className="note__dot" />
              <div style={{ flex: 1, minWidth: 0 }}>
                <b>{n.title}</b>
                <p>{n.body}</p>
                {n.inviteId ? (
                  <div className="row"><button className="btn btn--primary btn--sm" onClick={() => void accept(n)} data-testid="accept-invite">Join workspace</button><button className="btn btn--sm btn--ghost" onClick={() => void decline(n)}>Decline</button><span className="faint" style={{ fontSize: 11.5, marginLeft: "auto" }}>{ago(n.at)}</span></div>
                ) : n.href ? <button className="btn btn--sm" onClick={() => { setOpen(false); navigate(n.href!); }}>Open</button> : null}
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
