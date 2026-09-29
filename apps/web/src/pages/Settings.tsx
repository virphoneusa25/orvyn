import { useState } from "react";
import { api } from "../lib/api";
import { ago } from "../lib/format";
import { useStore } from "../lib/store";
import { useApi } from "../lib/useApi";
import { Icon } from "../components/Icons";
import { Modal } from "../components/Bits";

interface DeviceSession { id: string; device: string; createdAt: number; lastUsedAt: number; current: boolean }

export function Settings() {
  const { me, refresh, toast, signOut } = useStore();
  const [name, setName] = useState(me?.user.name ?? "");
  const sessions = useApi<{ sessions: DeviceSession[] }>("/auth/sessions");

  return (
    <>
      <h1 className="page-title">Settings</h1>
      <p className="page-sub">One ORVYN account for Cloud and Desktop.</p>
      <div className="two">
        <section className="card card--pad">
          <div className="card__head"><Icon.user size={24} /><h3>Profile</h3></div>
          <form onSubmit={async (e) => { e.preventDefault(); try { await api("/onboarding", { method: "PUT", body: { answers: { name } } }); await refresh(); toast("Saved."); } catch (err: any) { toast(err.message); } }}>
            <div className="field"><label htmlFor="s-name">Name</label><input id="s-name" className="input" value={name} onChange={(e) => setName(e.target.value)} /></div>
            <dl className="kv" style={{ marginBottom: 14 }}>
              <dt>Email</dt><dd>{me?.user.email}</dd>
              <dt>Workspace</dt><dd>{me?.principal.organizationName}</dd>
              <dt>Role</dt><dd style={{ textTransform: "capitalize" }}>{me?.principal.role}</dd>
            </dl>
            <button className="btn btn--primary" type="submit">Save</button>
          </form>
        </section>
        <section className="card card--pad">
          <div className="card__head"><Icon.shield size={24} /><h3>Security</h3></div>
          <p className="muted" style={{ marginTop: 0 }}>Devices signed in to your account.</p>
          <div className="list" data-testid="device-sessions">
            {(sessions.data?.sessions ?? []).map((s) => (
              <div key={s.id} className="list__row" style={{ cursor: "default" }}>
                <Icon.monitor size={20} />
                <span className="list__main"><b>{s.device}{s.current ? " · this browser" : ""}</b><span className="sub">Last active {ago(s.lastUsedAt)}</span></span>
                {!s.current ? <button className="btn btn--sm" onClick={async () => { await api(`/auth/sessions/${s.id}`, { method: "DELETE" }).catch(() => undefined); sessions.reload(); }}>Sign out</button> : null}
              </div>
            ))}
          </div>
          <div className="row" style={{ marginTop: 12, flexWrap: "wrap" }}>
            <button className="btn" onClick={async () => { try { const r = await api<{ ended: number }>("/auth/logout-all", { method: "POST", body: {} }); toast(`Signed out ${r.ended} other device${r.ended === 1 ? "" : "s"}.`); sessions.reload(); } catch (err: any) { toast(err.message); } }}>Sign out everywhere else</button>
            <button className="btn" onClick={async () => { await api("/auth/password/forgot", { method: "POST", body: { email: me?.user.email } }).catch(() => undefined); toast("We've emailed you a link to change your password."); }}>Change password</button>
            <button className="btn btn--danger" onClick={() => void signOut()}><Icon.logout size={16} /> Sign out</button>
          </div>
        </section>
      </div>
      <OwnModels />
    </>
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
    <section className="card card--pad" style={{ marginTop: 16 }}>
      <div className="card__head"><Icon.layers size={24} /><h3>Models</h3><button className="btn btn--sm" style={{ marginLeft: "auto" }} onClick={() => setAdding(true)}><Icon.plus size={14} /> Add your own model</button></div>
      <p className="muted" style={{ marginTop: 0 }}>ORVYN chooses the best model for each request when you pick <b>AUTO</b>. You can also pick Fast, Reasoning, Code, Research or Vision — or use your own model with your own provider account (it uses your key, not ORVYN credits for the model).</p>
      <div className="list">
        {models.filter((m) => m.kind === "orvyn").map((m) => (
          <div key={m.id} className="list__row" style={{ cursor: "default" }}><Icon.spark size={18} /><span className="list__main"><b>{m.id === "auto" ? "AUTO" : m.name}</b><span className="sub">{m.description}</span></span><span className="tag tag--violet">ORVYN</span></div>
        ))}
        {mine.map((m) => (
          <div key={m.id} className="list__row" style={{ cursor: "default" }}>
            <Icon.code size={18} /><span className="list__main"><b>{m.name}</b><span className="sub">Your model</span></span>
            <button className="btn btn--sm" onClick={async () => { try { const r = await api<{ ok: boolean; error?: string }>(`/models/${encodeURIComponent(m.id)}/test`, { method: "POST", body: {} }); toast(r.ok ? "It works." : r.error || "The model didn't answer."); } catch (err: any) { toast(err.message); } }}>Test</button>
            <button className="btn btn--sm btn--ghost" aria-label={`Remove ${m.name}`} onClick={async () => { await api(`/models/${encodeURIComponent(m.id)}`, { method: "DELETE" }).catch((e) => toast(e.message)); await refresh(); }}><Icon.trash size={14} /></button>
          </div>
        ))}
      </div>
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
            <div className="field"><label htmlFor="m-key">API key</label><input id="m-key" className="input" type="password" autoComplete="off" value={form.apiKey} onChange={(e) => setForm({ ...form, apiKey: e.target.value })} /></div>
            <p className="muted" style={{ fontSize: 12.5 }}>Your key is encrypted and never shown again.</p>
            <div className="modal__actions"><button type="button" className="btn" onClick={() => setAdding(false)}>Cancel</button><button className="btn btn--primary" type="submit" disabled={busy}>{busy ? "Adding…" : "Add model"}</button></div>
          </form>
        </Modal>
      ) : null}
    </section>
  );
}
