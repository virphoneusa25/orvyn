import { useState } from "react";
import { api, setToken } from "../lib/api";
import { ago, date } from "../lib/format";
import { navigate } from "../lib/router";
import { useStore } from "../lib/store";
import { signal } from "../lib/events";
import { useApi } from "../lib/useApi";
import { Icon } from "../components/Icons";
import { Empty, Modal, PageHead, hueFor, initials, workspaceLabel } from "../components/Bits";

interface DeviceSession { id: string; device: string; createdAt: number; lastUsedAt: number; current: boolean }
interface Member { userId: string; email: string; name: string | null; role: "owner" | "admin" | "member"; joinedAt: number; you: boolean }
interface Invite { id: string; email: string; role: string; createdAt: number; expiresAt: number }
interface Team { organization: { id: string; name: string; kind: string } | null; role: string; canManage: boolean; members: Member[]; invites: Invite[]; seats: { included: number; used: number }; plan: string }
interface ApiKey { id: string; name: string; prefix: string; createdAt: number; lastUsedAt: number | null }

const TABS: { id: string; label: string; icon: keyof typeof Icon }[] = [
  { id: "profile", label: "Profile", icon: "user" },
  { id: "security", label: "Security", icon: "shield" },
  { id: "team", label: "Team", icon: "users" },
  { id: "api-keys", label: "API keys", icon: "key" },
  { id: "connections", label: "Connections", icon: "plug" },
  { id: "models", label: "Models", icon: "layers" },
];

export function Settings({ tab = "profile" }: { tab?: string }) {
  const current = TABS.some((t) => t.id === tab) ? tab : "profile";
  return (
    <div className="page page--narrow" style={{ maxWidth: 1040 }}>
      <PageHead title="Settings" sub="One ORVYN account for Cloud and Desktop." />
      <div className="settings">
        <nav className="settings__nav" aria-label="Settings">
          {TABS.map((t) => {
            const I = Icon[t.icon] as (p: { size?: number }) => JSX.Element;
            return <button key={t.id} className={`nav__item${current === t.id ? " is-active" : ""}`} onClick={() => navigate(t.id === "profile" ? "/settings" : `/settings/${t.id}`)} data-testid={`settings-tab-${t.id}`}><I /> <span>{t.label}</span></button>;
          })}
        </nav>
        <div>
          {current === "profile" ? <Profile /> : null}
          {current === "security" ? <Security /> : null}
          {current === "team" ? <TeamSettings /> : null}
          {current === "api-keys" ? <ApiKeys /> : null}
          {current === "connections" ? <Connections /> : null}
          {current === "models" ? <OwnModels /> : null}
        </div>
      </div>
    </div>
  );
}

function Section({ title, sub, children, action }: { title: string; sub?: React.ReactNode; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <section className="card card--pad settings__section">
      <div className="spread" style={{ alignItems: "flex-start", marginBottom: 6 }}>
        <div><h2 style={{ fontSize: 16, fontWeight: 650, margin: 0 }}>{title}</h2>{sub ? <p className="muted" style={{ margin: "4px 0 0", fontSize: 13.5 }}>{sub}</p> : null}</div>
        {action}
      </div>
      <div style={{ marginTop: 10 }}>{children}</div>
    </section>
  );
}

function Profile() {
  const { me, refresh, toast } = useStore();
  const [name, setName] = useState(me?.user.name ?? "");
  const [busy, setBusy] = useState(false);
  return (
    <>
      <Section title="Profile" sub="How you appear to your team and in ORVYN Desktop.">
        <div className="row" style={{ marginBottom: 16 }}>
          <span className="me__avatar" style={{ width: 52, height: 52, fontSize: 18 }}>{initials(me?.user.name, me?.user.email)}</span>
          <div><b>{me?.user.name || "—"}</b><div className="muted" style={{ fontSize: 13 }}>{me?.user.email}</div></div>
        </div>
        <form onSubmit={async (e) => { e.preventDefault(); setBusy(true); try { await api("/account/profile", { method: "PATCH", body: { name } }); await refresh(); toast("Profile saved."); } catch (err: any) { toast(err.message); } finally { setBusy(false); } }}>
          <div className="two">
            <div className="field"><label htmlFor="s-name">Full name</label><input id="s-name" className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} /></div>
            <div className="field"><label htmlFor="s-email">Email</label><input id="s-email" className="input" value={me?.user.email ?? ""} readOnly /></div>
          </div>
          <button className="btn btn--primary" type="submit" disabled={busy || name.trim() === (me?.user.name ?? "")} data-testid="save-profile">Save changes</button>
        </form>
      </Section>
      <Section title="Workspace" sub="The workspace you're signed in to right now.">
        <dl className="kv">
          <dt>Name</dt><dd>{me ? workspaceLabel({ name: me.principal.organizationName, kind: me.principal.organizationKind }, me.user.name) : ""}</dd>
          <dt>Your role</dt><dd style={{ textTransform: "capitalize" }}>{me?.principal.role}</dd>
          <dt>Workspaces</dt><dd>{me?.organizations.length ?? 1} — switch from the bottom of the sidebar</dd>
        </dl>
      </Section>
    </>
  );
}

function Security() {
  const { me, toast, signOut } = useStore();
  const sessions = useApi<{ sessions: DeviceSession[] }>("/auth/sessions");
  const [pw, setPw] = useState({ current: "", next: "", confirm: "" });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <>
      <Section title="Password" sub="Changing it signs out every other device.">
        <form onSubmit={async (e) => {
          e.preventDefault(); setErr(null);
          if (pw.next.length < 8) return setErr("Use at least 8 characters.");
          if (pw.next !== pw.confirm) return setErr("The new passwords don't match.");
          setBusy(true);
          try { const r = await api<{ signedOut: number }>("/account/password", { method: "POST", body: { current: pw.current, next: pw.next } }); setPw({ current: "", next: "", confirm: "" }); sessions.reload(); toast(`Password changed.${r.signedOut ? ` Signed out ${r.signedOut} other device${r.signedOut === 1 ? "" : "s"}.` : ""}`); }
          catch (e2: any) { setErr(e2.message); } finally { setBusy(false); }
        }}>
          <div className="field" style={{ maxWidth: 360 }}><label htmlFor="pw-cur">Current password</label><input id="pw-cur" className="input" type="password" autoComplete="current-password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} /></div>
          <div className="two" style={{ maxWidth: 740 }}>
            <div className="field"><label htmlFor="pw-new">New password</label><input id="pw-new" className="input" type="password" autoComplete="new-password" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} /></div>
            <div className="field"><label htmlFor="pw-conf">Confirm new password</label><input id="pw-conf" className="input" type="password" autoComplete="new-password" value={pw.confirm} onChange={(e) => setPw({ ...pw, confirm: e.target.value })} /></div>
          </div>
          {err ? <div className="error" role="alert">{err}</div> : null}
          <div className="row">
            <button className="btn btn--primary" type="submit" disabled={busy || !pw.current || !pw.next} data-testid="change-password">Change password</button>
            <button type="button" className="btn btn--ghost" onClick={async () => { await api("/auth/password/forgot", { method: "POST", body: { email: me?.user.email } }).catch(() => undefined); toast("We've emailed you a reset link."); }}>Forgot it? Email me a link</button>
          </div>
        </form>
      </Section>
      <Section title="Where you're signed in" sub="Browsers and ORVYN Desktop apps with access to your account." action={<button className="btn btn--sm" onClick={async () => { try { const r = await api<{ ended: number }>("/auth/logout-all", { method: "POST", body: {} }); toast(`Signed out ${r.ended} other device${r.ended === 1 ? "" : "s"}.`); sessions.reload(); } catch (e2: any) { toast(e2.message); } }}>Sign out everywhere else</button>}>
        <div data-testid="device-sessions">
          {(sessions.data?.sessions ?? []).map((s) => (
            <div key={s.id} className="setting-row">
              <span className="qa__icon" style={{ width: 34, height: 34 }}>{/desktop|electron/i.test(s.device) ? <Icon.monitor size={17} /> : <Icon.globe size={17} />}</span>
              <div className="grow"><b>{s.device}{s.current ? <span className="tag tag--green" style={{ marginLeft: 8 }}>This browser</span> : null}</b><span className="sub">Signed in {date(s.createdAt)} · active {ago(s.lastUsedAt)}</span></div>
              {!s.current ? <button className="btn btn--sm" onClick={async () => { await api(`/auth/sessions/${s.id}`, { method: "DELETE" }).catch(() => undefined); sessions.reload(); }}>Sign out</button> : null}
            </div>
          ))}
        </div>
      </Section>
      <Section title="Sign out" sub="End this browser's session.">
        <button className="btn btn--danger" onClick={() => void signOut()}><Icon.logout size={16} /> Sign out</button>
      </Section>
    </>
  );
}

function TeamSettings() {
  const { me, refresh, toast } = useStore();
  const team = useApi<Team>("/account/team");
  const [inviting, setInviting] = useState(false);
  const [link, setLink] = useState<{ url: string; emailed: boolean; email: string } | null>(null);
  const [removing, setRemoving] = useState<Member | null>(null);
  const [renaming, setRenaming] = useState(false);
  const t = team.data;
  if (team.error) return <Section title="Team"><div className="error">{team.error}</div></Section>;
  if (!t) return <Section title="Team"><div className="skeleton" style={{ height: 120 }} /></Section>;
  const wsName = t.organization ? workspaceLabel(t.organization, me?.user.name) : "Workspace";
  const seatsLeft = Math.max(0, t.seats.included - t.seats.used);

  const setRole = async (m: Member, role: string) => { try { await api(`/account/team/members/${m.userId}`, { method: "PATCH", body: { role } }); team.reload(); toast("Role updated."); } catch (err: any) { toast(err.message); } };
  const leave = async () => {
    try {
      await api("/account/team/leave", { method: "POST", body: {} });
      const personal = me?.organizations.find((o) => o.kind === "personal");
      if (personal) { const r = await api<{ token: string }>("/auth/switch-organization", { method: "POST", body: { organizationId: personal.id } }).catch(() => null); if (r) setToken(r.token); }
      await refresh(); signal("sessions"); navigate("/"); toast("You left the workspace.");
    } catch (err: any) { toast(err.message); }
  };

  return (
    <>
      <Section title={wsName} sub={<>{t.members.length} member{t.members.length === 1 ? "" : "s"} · {t.plan} plan · {t.seats.included ? `${t.seats.used} of ${t.seats.included} team seats used` : "no team seats on this plan"}</>}
        action={t.canManage ? <div className="row"><button className="btn btn--sm btn--ghost" onClick={() => setRenaming(true)}><Icon.edit size={14} /> Rename</button><button className="btn btn--primary btn--sm" onClick={() => setInviting(true)} disabled={!t.seats.included} data-testid="invite-open"><Icon.plus size={14} /> Invite people</button></div> : null}>
        {!t.seats.included ? (
          <div className="notice notice--violet" data-testid="team-upsell"><b>Work together on Business or Team.</b> Invite people to share projects, files and credits in one workspace. <a href="/billing#plans" onClick={(e) => { e.preventDefault(); navigate("/billing#plans"); }}>See plans</a></div>
        ) : seatsLeft === 0 && t.canManage ? <div className="notice notice--warn">All team seats are in use. Remove someone or upgrade for more seats.</div> : null}
        <div data-testid="team-members">
          {t.members.map((m) => (
            <div key={m.userId} className="setting-row">
              <span className="avatar-sm" style={{ background: hueFor(m.email) }}>{initials(m.name, m.email)}</span>
              <div className="grow"><b>{m.name || m.email}{m.you ? <span className="faint" style={{ fontWeight: 400 }}> (you)</span> : null}</b><span className="sub">{m.email} · joined {date(m.joinedAt)}</span></div>
              {m.role === "owner" || !t.canManage || m.you ? <span className="tag tag--muted" style={{ textTransform: "capitalize" }}>{m.role}</span> : (
                <select className="input select" style={{ height: 32, width: 120 }} value={m.role} onChange={(e) => void setRole(m, e.target.value)} aria-label={`Role for ${m.email}`}>
                  <option value="member">Member</option><option value="admin" disabled={t.role !== "owner"}>Admin</option>
                </select>
              )}
              {t.canManage && m.role !== "owner" && !m.you ? <button className="btn btn--sm btn--ghost btn--icon" onClick={() => setRemoving(m)} aria-label={`Remove ${m.email}`} title="Remove"><Icon.trash size={15} /></button> : null}
              {m.you && m.role !== "owner" ? <button className="btn btn--sm" onClick={() => void leave()}>Leave</button> : null}
            </div>
          ))}
        </div>
      </Section>
      {t.invites.length ? (
        <Section title="Pending invitations" sub="Invitations work for 7 days and only for the invited email.">
          {t.invites.map((i) => (
            <div key={i.id} className="setting-row" data-testid="invite-row">
              <span className="qa__icon" style={{ width: 32, height: 32 }}><Icon.mail size={16} /></span>
              <div className="grow"><b>{i.email}</b><span className="sub">Invited as {i.role} · expires {date(i.expiresAt)}</span></div>
              {t.canManage ? <button className="btn btn--sm" onClick={async () => { await api(`/account/team/invites/${i.id}`, { method: "DELETE" }).catch(() => undefined); team.reload(); }}>Revoke</button> : null}
            </div>
          ))}
        </Section>
      ) : null}
      {inviting ? <InviteModal isOwner={t.role === "owner"} onClose={() => setInviting(false)} onDone={(r) => { setInviting(false); setLink(r); team.reload(); }} /> : null}
      {link ? (
        <Modal title="Invitation ready" onClose={() => setLink(null)}>
          <p className="muted" style={{ marginTop: 0 }}>{link.emailed ? `We emailed ${link.email}. You can also send them this link — it only works for that email:` : `Email isn't set up on this server, so send ${link.email} this link yourself. It only works for that email:`}</p>
          <div className="secret" data-testid="invite-link"><code>{link.url}</code><button className="btn btn--sm" onClick={() => { void navigator.clipboard?.writeText(link.url); toast("Link copied."); }}><Icon.copy size={14} /> Copy</button></div>
          <div className="modal__actions"><button className="btn btn--primary" onClick={() => setLink(null)}>Done</button></div>
        </Modal>
      ) : null}
      {removing ? (
        <Modal title={`Remove ${removing.name || removing.email}?`} onClose={() => setRemoving(null)}>
          <p className="muted" style={{ marginTop: 0 }}>They lose access to this workspace right away and are signed out of it. Their chats and files here stay in the workspace.</p>
          <div className="modal__actions"><button className="btn" onClick={() => setRemoving(null)}>Cancel</button><button className="btn btn--danger" data-testid="confirm-remove-member" onClick={async () => { try { await api(`/account/team/members/${removing.userId}`, { method: "DELETE" }); team.reload(); } catch (err: any) { toast(err.message); } setRemoving(null); }}>Remove</button></div>
        </Modal>
      ) : null}
      {renaming ? <RenameWorkspace current={t.organization?.name ?? ""} onClose={() => setRenaming(false)} onDone={async () => { setRenaming(false); team.reload(); await refresh(); }} /> : null}
    </>
  );
}

function RenameWorkspace({ current, onClose, onDone }: { current: string; onClose: () => void; onDone: () => void }) {
  const { toast } = useStore();
  const [name, setName] = useState(current);
  return (
    <Modal title="Rename workspace" onClose={onClose}>
      <form onSubmit={async (e) => { e.preventDefault(); try { await api("/account/team", { method: "PATCH", body: { name } }); onDone(); } catch (err: any) { toast(err.message); } }}>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} autoFocus maxLength={80} aria-label="Workspace name" />
        <div className="modal__actions"><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn btn--primary" type="submit">Save</button></div>
      </form>
    </Modal>
  );
}

function InviteModal({ isOwner, onClose, onDone }: { isOwner: boolean; onClose: () => void; onDone: (r: { url: string; emailed: boolean; email: string }) => void }) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("member");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <Modal title="Invite people" onClose={onClose}>
      <form onSubmit={async (e) => {
        e.preventDefault(); setErr(null); setBusy(true);
        try { const r = await api<{ link: string; emailed: boolean; invite: { email: string } }>("/account/team/invites", { method: "POST", body: { email, role } }); onDone({ url: r.link, emailed: r.emailed, email: r.invite.email }); }
        catch (e2: any) { setErr(e2.message); } finally { setBusy(false); }
      }}>
        <div className="field"><label htmlFor="inv-email">Email address</label><input id="inv-email" className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus placeholder="name@company.com" required /></div>
        <div className="field"><label htmlFor="inv-role">Role</label>
          <select id="inv-role" className="input select" style={{ width: "100%" }} value={role} onChange={(e) => setRole(e.target.value)}>
            <option value="member">Member — uses the workspace's projects, files and credits</option>
            {isOwner ? <option value="admin">Admin — can also invite and manage members</option> : null}
          </select>
        </div>
        {err ? <div className="error" role="alert">{err}</div> : null}
        <div className="modal__actions"><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn btn--primary" type="submit" disabled={busy} data-testid="invite-send">{busy ? "Sending…" : "Send invitation"}</button></div>
      </form>
    </Modal>
  );
}

function ApiKeys() {
  const { toast } = useStore();
  const keys = useApi<{ included: boolean; keys: ApiKey[] }>("/account/api-keys");
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [fresh, setFresh] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<ApiKey | null>(null);
  const k = keys.data;
  return (
    <>
      <Section title="API keys" sub={<>Use ORVYN from your own code with the same account, credits and limits. Send the key as <code>Authorization: Bearer …</code>.</>}
        action={k?.included ? <button className="btn btn--primary btn--sm" onClick={() => setCreating(true)} data-testid="new-api-key"><Icon.plus size={14} /> Create key</button> : null}>
        {!k ? <div className="skeleton" style={{ height: 80 }} /> : !k.included ? (
          <div className="notice notice--violet" data-testid="api-upsell"><b>API access is included on the Business and Team plans.</b> <a href="/billing#plans" onClick={(e) => { e.preventDefault(); navigate("/billing#plans"); }}>See plans</a></div>
        ) : !k.keys.length ? <Empty icon={<Icon.key size={22} />} title="No API keys yet">Create a key for a script, a CI job or an integration. You'll see it once.</Empty> : (
          <div data-testid="api-keys">
            {k.keys.map((key) => (
              <div key={key.id} className="setting-row">
                <span className="qa__icon" style={{ width: 32, height: 32 }}><Icon.key size={16} /></span>
                <div className="grow"><b>{key.name}</b><span className="sub"><code>{key.prefix}…</code> · created {date(key.createdAt)} · {key.lastUsedAt ? `last used ${ago(key.lastUsedAt)}` : "never used"}</span></div>
                <button className="btn btn--sm btn--danger" onClick={() => setRevoking(key)}>Revoke</button>
              </div>
            ))}
          </div>
        )}
      </Section>
      {creating ? (
        <Modal title="Create API key" onClose={() => setCreating(false)}>
          <form onSubmit={async (e) => { e.preventDefault(); try { const r = await api<{ key: string }>("/account/api-keys", { method: "POST", body: { name } }); setCreating(false); setName(""); setFresh(r.key); keys.reload(); } catch (err: any) { toast(err.message); } }}>
            <div className="field"><label htmlFor="key-name">Name</label><input id="key-name" className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. CI pipeline" autoFocus maxLength={60} /></div>
            <div className="modal__actions"><button type="button" className="btn" onClick={() => setCreating(false)}>Cancel</button><button className="btn btn--primary" type="submit" data-testid="create-api-key">Create key</button></div>
          </form>
        </Modal>
      ) : null}
      {fresh ? (
        <Modal title="Copy your new key" onClose={() => setFresh(null)}>
          <p className="muted" style={{ marginTop: 0 }}>This is the only time the full key is shown. Store it somewhere safe — anyone with it can use your account's credits.</p>
          <div className="secret" data-testid="api-key-secret"><code>{fresh}</code><button className="btn btn--sm" onClick={() => { void navigator.clipboard?.writeText(fresh); toast("Key copied."); }}><Icon.copy size={14} /> Copy</button></div>
          <div className="modal__actions"><button className="btn btn--primary" onClick={() => setFresh(null)}>I've saved it</button></div>
        </Modal>
      ) : null}
      {revoking ? (
        <Modal title={`Revoke “${revoking.name}”?`} onClose={() => setRevoking(null)}>
          <p className="muted" style={{ marginTop: 0 }}>Anything using this key stops working immediately.</p>
          <div className="modal__actions"><button className="btn" onClick={() => setRevoking(null)}>Cancel</button><button className="btn btn--danger" onClick={async () => { await api(`/account/api-keys/${revoking.id}`, { method: "DELETE" }).catch(() => undefined); setRevoking(null); keys.reload(); }}>Revoke key</button></div>
        </Modal>
      ) : null}
    </>
  );
}

function Connections() {
  const { toast } = useStore();
  const c = useApi<{ github: { connected: boolean; login?: string }; deployment: Record<string, { connected: boolean }>; desktop: { connected: boolean; devices: { id: string; device: string; lastUsedAt: number }[] } }>("/account/connections");
  const [editing, setEditing] = useState<string | null>(null);
  const [token, setTokenValue] = useState("");
  const providers = [["vercel", "Vercel"], ["netlify", "Netlify"], ["cloudflare", "Cloudflare"]] as const;
  return (
    <Section title="Connections" sub="Apps and services linked to your ORVYN account.">
      <div className="setting-row">
        <span className="qa__icon" style={{ width: 36, height: 36 }}><Icon.monitor size={18} /></span>
        <div className="grow"><b>ORVYN Desktop</b><span className="sub">{c.data?.desktop.connected ? c.data.desktop.devices.map((d) => `${d.device} · active ${ago(d.lastUsedAt)}`).join(" · ") : "Not signed in on a computer yet."}</span></div>
        {c.data?.desktop.connected ? <span className="tag tag--green">Connected</span> : <button className="btn btn--sm" onClick={() => navigate("/download")}>Download</button>}
      </div>
      <div className="setting-row">
        <span className="qa__icon" style={{ width: 36, height: 36 }}><Icon.github /></span>
        <div className="grow"><b>GitHub</b><span className="sub">{c.data?.github.connected ? `Connected as ${c.data.github.login ?? "your account"} — ORVYN can work with your repositories.` : "Connect from ORVYN Desktop to let ORVYN work with your repositories."}</span></div>
        {c.data?.github.connected ? <span className="tag tag--green">Connected</span> : <span className="tag tag--muted">Not connected</span>}
      </div>
      {providers.map(([id, label]) => {
        const connected = c.data?.deployment?.[id]?.connected;
        return <div className="setting-row" key={id}>
          <span className="qa__icon" style={{ width: 36, height: 36 }}><Icon.plug size={18} /></span>
          <div className="grow"><b>{label}</b><span className="sub">{connected ? "Deployment credential stored securely for approved cloud missions." : `Connect ${label} for approved deployment missions.`}</span></div>
          {connected ? <><span className="tag tag--green">Connected</span><button className="btn btn--sm btn--ghost" onClick={async () => { await api(`/account/connections/${id}`, { method: "DELETE" }); c.reload(); toast(`${label} disconnected.`); }}>Disconnect</button></> : <button className="btn btn--sm" onClick={() => { setEditing(id); setTokenValue(""); }}>Connect</button>}
        </div>;
      })}
      {editing ? <Modal title={`Connect ${providers.find(([id]) => id === editing)?.[1] ?? editing}`} onClose={() => setEditing(null)}>
        <form onSubmit={async (e) => { e.preventDefault(); try { await api(`/account/connections/${editing}`, { method: "PUT", body: { token } }); toast("Connection saved."); setEditing(null); setTokenValue(""); c.reload(); } catch (err: any) { toast(err.message); } }}>
          <div className="field"><label htmlFor="deployment-token">Provider token</label><input id="deployment-token" className="input" type="password" autoComplete="off" value={token} onChange={(e) => setTokenValue(e.target.value)} required /><span className="hint">Encrypted and never shown again. It is released only through an approved sandbox credential profile.</span></div>
          <div className="modal__actions"><button type="button" className="btn" onClick={() => setEditing(null)}>Cancel</button><button className="btn btn--primary" type="submit" disabled={token.trim().length < 12}>Connect</button></div>
        </form>
      </Modal> : null}
    </Section>
  );
}

/** ORVYN's models are fixed; a customer can add their own (an OpenAI-compatible endpoint and key). */
function OwnModels() {
  const { models, refresh, toast } = useStore();
  const mine = models.filter((m) => m.kind === "user");
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ name: "", endpoint: "", apiModelId: "", apiKey: "" });
  const [busy, setBusy] = useState(false);
  return (
    <Section title="Models" sub={<>Pick <b>AUTO</b> and ORVYN chooses the best model for each request, or choose Fast, Reasoning, Code, Research or Vision. You can also bring your own model — it uses your provider key, not ORVYN credits for the model.</>}
      action={<button className="btn btn--sm" onClick={() => setAdding(true)}><Icon.plus size={14} /> Add your own model</button>}>
      {models.filter((m) => m.kind === "orvyn").map((m) => (
        <div key={m.id} className="setting-row"><span className="qa__icon" style={{ width: 32, height: 32 }}><Icon.spark size={16} /></span><div className="grow"><b>{m.id === "auto" ? "AUTO" : m.name}</b><span className="sub">{m.description}</span></div><span className="tag tag--violet">ORVYN</span></div>
      ))}
      {mine.map((m) => (
        <div key={m.id} className="setting-row">
          <span className="qa__icon" style={{ width: 32, height: 32 }}><Icon.code size={16} /></span><div className="grow"><b>{m.name}</b><span className="sub">Your model</span></div>
          <button className="btn btn--sm" onClick={async () => { try { const r = await api<{ ok: boolean; error?: string }>(`/models/${encodeURIComponent(m.id)}/test`, { method: "POST", body: {} }); toast(r.ok ? "It works." : r.error || "The model didn't answer."); } catch (err: any) { toast(err.message); } }}>Test</button>
          <button className="btn btn--sm btn--ghost btn--icon" aria-label={`Remove ${m.name}`} onClick={async () => { await api(`/models/${encodeURIComponent(m.id)}`, { method: "DELETE" }).catch((e) => toast(e.message)); await refresh(); }}><Icon.trash size={14} /></button>
        </div>
      ))}
      {adding ? (
        <Modal title="Add your own model" onClose={() => setAdding(false)}>
          <form onSubmit={async (e) => {
            e.preventDefault(); setBusy(true);
            try { await api("/models", { method: "POST", body: form }); await refresh(); setAdding(false); setForm({ name: "", endpoint: "", apiModelId: "", apiKey: "" }); toast("Model added. Pick it from the model menu."); }
            catch (err: any) { toast(err.message); } finally { setBusy(false); }
          }}>
            <div className="field"><label htmlFor="m-name">Name</label><input id="m-name" className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="My model" required /></div>
            <div className="field"><label htmlFor="m-ep">API base URL (OpenAI-compatible)</label><input id="m-ep" className="input" value={form.endpoint} onChange={(e) => setForm({ ...form, endpoint: e.target.value })} placeholder="https://api.example.com/v1" required /></div>
            <div className="field"><label htmlFor="m-id">Model name at your provider</label><input id="m-id" className="input" value={form.apiModelId} onChange={(e) => setForm({ ...form, apiModelId: e.target.value })} required /></div>
            <div className="field"><label htmlFor="m-key">API key</label><input id="m-key" className="input" type="password" autoComplete="off" value={form.apiKey} onChange={(e) => setForm({ ...form, apiKey: e.target.value })} /><span className="hint">Encrypted and never shown again.</span></div>
            <div className="modal__actions"><button type="button" className="btn" onClick={() => setAdding(false)}>Cancel</button><button className="btn btn--primary" type="submit" disabled={busy}>{busy ? "Adding…" : "Add model"}</button></div>
          </form>
        </Modal>
      ) : null}
    </Section>
  );
}
