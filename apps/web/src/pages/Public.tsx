import { useEffect, useState } from "react";
import { api, setToken } from "../lib/api";
import { date } from "../lib/format";
import { Markdown } from "../lib/markdown";
import { navigate, useLocation } from "../lib/router";
import { useStore } from "../lib/store";
import { signal } from "../lib/events";
import { Orb } from "../components/Orb";
import { Icon } from "../components/Icons";

const INVITE_KEY = "orvyn.invite";

export function rememberInvite(token: string): void { try { sessionStorage.setItem(INVITE_KEY, token); } catch { /* storage off */ } }
export function pendingInvite(): string | null { try { return sessionStorage.getItem(INVITE_KEY); } catch { return null; } }
function forgetInvite(): void { try { sessionStorage.removeItem(INVITE_KEY); } catch { /* storage off */ } }

/** A read-only conversation someone shared (no account needed). Text only. */
export function SharedChat({ token }: { token: string }) {
  const [data, setData] = useState<{ title: string; sharedAt: number; author: string | null; messages: { role: string; content: string; createdAt: number }[] } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    fetch(`/api/v1/public/shares/${encodeURIComponent(token)}`).then(async (r) => { const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || "This shared conversation isn't available."); setData(j); }).catch((e) => setErr(e.message));
  }, [token]);
  return (
    <div className="standalone" data-testid="shared-chat">
      <div className="standalone__top">
        <span className="brand__mark" style={{ width: 30, height: 30 }}><Orb /></span>
        <b style={{ letterSpacing: "0.14em" }}>ORVYN</b>
        <span className="muted" style={{ fontSize: 13 }}>Shared conversation</span>
        <a className="btn btn--primary btn--sm" style={{ marginLeft: "auto" }} href="/">Try ORVYN</a>
      </div>
      <div className="standalone__body">
        {err ? <div className="card empty"><h3>Not available</h3>{err}</div> : !data ? <div className="empty">Loading…</div> : (
          <>
            <h1 className="page-title" style={{ marginBottom: 4 }}>{data.title}</h1>
            <p className="page-sub" style={{ marginBottom: 24 }}>Shared {data.author ? `by ${data.author} ` : ""}· {date(data.sharedAt)} · read-only</p>
            <div className="chat__inner" style={{ padding: 0 }}>
              {data.messages.map((m, i) => (
                <div key={i} className={`msg msg--${m.role}`}>
                  {m.role === "assistant" ? <span className="msg__avatar"><Orb /></span> : null}
                  <div className="msg__body"><div className="bubble">{m.role === "assistant" ? <Markdown text={m.content} /> : <p style={{ whiteSpace: "pre-wrap" }}>{m.content}</p>}</div></div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** Joining a workspace from an invitation link (the signed-in account must own the invited email). */
export function InvitePage() {
  const { query } = useLocation();
  const { me, refresh, toast, signOut } = useStore();
  const token = query.get("token") || pendingInvite() || "";
  const [info, setInfo] = useState<{ organizationName: string; role: string; invitedBy: string | null; email: string; matches: boolean } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!token) { setErr("This invitation link is incomplete."); return; }
    rememberInvite(token);
    api<typeof info>(`/account/invites/${encodeURIComponent(token)}`).then(setInfo).catch((e) => setErr(e.message));
  }, [token]);
  const accept = async () => {
    setBusy(true);
    try {
      const r = await api<{ organization: { id: string; name: string } }>("/account/invites/accept", { method: "POST", body: { token } });
      forgetInvite();
      const sw = await api<{ token: string }>("/auth/switch-organization", { method: "POST", body: { organizationId: r.organization.id } });
      setToken(sw.token);
      await refresh(); signal("sessions"); signal("projects"); signal("files");
      navigate("/", { replace: true });
      toast(`Welcome to ${r.organization.name}.`);
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  return (
    <div className="page" style={{ maxWidth: 520, paddingTop: "6vh" }} data-testid="invite-page">
      <div className="card card--pad" style={{ textAlign: "center", padding: 32 }}>
        <div className="auth__orb" style={{ width: 80, height: 80 }}><Orb /></div>
        {err ? (<><h1 className="page-title" style={{ fontSize: 20 }}>Invitation unavailable</h1><p className="muted">{err}</p><button className="btn" onClick={() => { forgetInvite(); navigate("/"); }}>Go to ORVYN</button></>) : !info ? <p className="muted">Loading invitation…</p> : (
          <>
            <h1 className="page-title" style={{ fontSize: 21 }}>Join {info.organizationName}</h1>
            <p className="muted">{info.invitedBy ?? "Someone"} invited <b>{info.email}</b> to join as {info.role === "admin" ? "an admin" : "a member"}. You'll share its projects, files and credits.</p>
            {info.matches ? (
              <div className="row" style={{ justifyContent: "center", marginTop: 18 }}>
                <button className="btn" onClick={() => { forgetInvite(); navigate("/"); }}>Not now</button>
                <button className="btn btn--primary" onClick={() => void accept()} disabled={busy} data-testid="invite-accept"><Icon.check size={16} /> Join workspace</button>
              </div>
            ) : (
              <>
                <div className="notice notice--warn" style={{ marginTop: 14 }}>You're signed in as {me?.user.email}. This invitation is for {info.email}.</div>
                <button className="btn" onClick={() => void signOut()}>Sign in with {info.email}</button>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
