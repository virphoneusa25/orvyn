import React, { useCallback, useEffect, useState } from "react";
import { apiUrl, authHeaders, getConnectionConfig, isSessionToken } from "../connection";

// Settings → Security: the devices signed in to this account, sign out of
// one or all of them, and a password reset link by email.

interface SessionRow { id: string; device: string; createdAt: number; lastUsedAt: number; current: boolean }

async function call(path: string, method = "GET", body?: unknown): Promise<any> {
  const r = await fetch(apiUrl(path), { method, headers: { "Content-Type": "application/json", ...authHeaders() }, body: body === undefined ? undefined : JSON.stringify(body) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || `Request failed (${r.status})`);
  return d;
}

function when(ts: number): string {
  const mins = Math.round((Date.now() - ts) / 60_000);
  if (mins < 2) return "Active now";
  if (mins < 60) return `${mins} min ago`;
  const h = Math.round(mins / 60);
  if (h < 48) return `${h} h ago`;
  return new Date(ts).toLocaleDateString();
}

export function AccountSecurity() {
  const [sessions, setSessions] = useState<SessionRow[] | null>(null);
  const [email, setEmail] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const signedIn = isSessionToken(getConnectionConfig().apiKey);

  const load = useCallback(async () => {
    if (!signedIn) return;
    try {
      const [s, me] = await Promise.all([call("/auth/sessions"), call("/auth/me")]);
      setSessions(s.sessions ?? []);
      setEmail(me.user?.email ?? "");
    } catch (e: any) { setError(e.message); }
  }, [signedIn]);
  useEffect(() => { void load(); }, [load]);

  async function run(fn: () => Promise<unknown>, done?: string) {
    setBusy(true); setError(null); setNote(null);
    try { await fn(); if (done) setNote(done); await load(); } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  }

  if (!signedIn) return <section><h1>Security</h1><p className="settings-lead">Sign in to ORVYN to manage your account security.</p></section>;

  return (
    <section data-testid="account-security">
      <h1>Security</h1>
      <p className="settings-lead">Devices signed in to {email || "your account"}. Sign out of any you don't recognise.</p>
      {error && <div role="alert" style={{ color: "#e06c75", fontSize: 12, margin: "8px 0" }}>{error}</div>}
      {note && <div role="status" style={{ fontSize: 12, margin: "8px 0", color: "var(--orvyn-text-muted, #8b97b0)" }}>{note}</div>}
      <div className="settings-card" style={{ marginTop: 12 }}>
        {!sessions ? <div style={{ fontSize: 12 }}>Loading…</div> : sessions.map((s) => (
          <div key={s.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 0", borderBottom: "1px solid rgba(255,255,255,.06)" }} data-testid="session-row">
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 600 }}>{s.device}{s.current ? <span style={{ marginLeft: 8, fontSize: 11, color: "#8b97b0" }}>This device</span> : null}</div>
              <div style={{ fontSize: 12, color: "#8b97b0" }}>{when(s.lastUsedAt)} · signed in {new Date(s.createdAt).toLocaleDateString()}</div>
            </div>
            {!s.current && <button type="button" className="settings-btn" disabled={busy} onClick={() => void run(() => call(`/auth/sessions/${encodeURIComponent(s.id)}`, "DELETE"), "Signed out.")}>Sign out</button>}
          </div>
        ))}
        <div style={{ display: "flex", gap: 8, marginTop: 14, flexWrap: "wrap" }}>
          <button type="button" className="settings-btn" disabled={busy || (sessions?.length ?? 0) < 2} onClick={() => void run(() => call("/auth/logout-all", "POST", {}), "Every other device was signed out.")}>Sign out of all other devices</button>
          <button type="button" className="settings-btn" disabled={busy || !email} onClick={() => void run(() => call("/auth/password/forgot", "POST", { email }), `A password reset link was sent to ${email}.`)}>Change password</button>
        </div>
      </div>
    </section>
  );
}
