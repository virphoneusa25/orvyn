import React, { useEffect, useState } from "react";
import { getConnectionConfig, loadConnectionConfig, saveConnectionConfig, apiUrl, authHeaders, isSessionToken, ORVYN_CLOUD_URL } from "../connection";
import { onConnectionFacts, signInWithCredentials, signOutOfCloud } from "../connectionRuntime";
import { describeConnection } from "../connectionState";

interface ProfileInfo {
  id: string;
  label: string;
  description: string;
}

interface AccountUser {
  id: string;
  email: string;
  name: string | null;
}

export function ConnectionSettings() {
  const [backendUrl, setBackendUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [status, setStatus] = useState<"idle" | "testing" | "ok" | "error">("idle");
  const [statusDetail, setStatusDetail] = useState("");
  const [saved, setSaved] = useState(false);
  const [profile, setProfile] = useState<string | null>(null);
  const [profiles, setProfiles] = useState<ProfileInfo[]>([]);
  const [profileError, setProfileError] = useState("");
  const [account, setAccount] = useState<AccountUser | null>(null);
  const [authMode, setAuthMode] = useState<"signin" | "register">("signin");
  const [authEmail, setAuthEmail] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [authName, setAuthName] = useState("");
  const [authError, setAuthError] = useState("");
  const [authBusy, setAuthBusy] = useState(false);
  const [stateLine, setStateLine] = useState("Local workspace");

  useEffect(() => {
    loadConnectionConfig().then((c) => {
      setBackendUrl(c.backendUrl);
      setApiKey(c.apiKey.startsWith("orvsess_") ? "" : c.apiKey);
    });
    const off = onConnectionFacts((f) => {
      const view = describeConnection(f);
      setStateLine(view.userSubtitle);
      if (f.accountState === "signed-in" && f.accountEmail) {
        setAccount({ id: "", email: f.accountEmail, name: f.accountName });
      } else if (f.accountState !== "signed-in") {
        setAccount(null);
      }
    });
    fetch(apiUrl("/profile"), { headers: authHeaders() })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d) => {
        setProfile(d.profile);
        setProfiles(d.profiles ?? []);
      })
      .catch(() => setProfileError("Backend unreachable — profile unavailable"));
    return () => off();
  }, []);

  async function selectProfile(id: string) {
    setProfileError("");
    try {
      const res = await fetch(apiUrl("/profile"), {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ profile: id }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setProfile(id);
    } catch (err: any) {
      setProfileError(`Could not set profile: ${err.message}`);
    }
  }

  async function handleTest() {
    setStatus("testing");
    try {
      const res = await fetch(`${backendUrl.replace(/\/$/, "")}/api/v1/health`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setStatus("ok");
      setStatusDetail(`${data.service} v${data.version}`);
    } catch (err: any) {
      setStatus("error");
      setStatusDetail(err.message);
    }
  }

  async function handleSave() {
    const existing = getConnectionConfig();
    const nextKey = apiKey.trim() || (isSessionToken(existing.apiKey) ? existing.apiKey : "");
    await saveConnectionConfig({ backendUrl: backendUrl.trim(), apiKey: nextKey });
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  async function handleAuth() {
    setAuthError("");
    setAuthBusy(true);
    const base = backendUrl.trim() || ORVYN_CLOUD_URL;
    const result = await signInWithCredentials({
      backendUrl: base,
      email: authEmail,
      password: authPassword,
      name: authName,
      mode: authMode === "register" ? "register" : "login",
    });
    setAuthBusy(false);
    if (!result.ok) {
      setAuthError(result.error);
      return;
    }
    setBackendUrl(base);
    setApiKey("");
    setAuthPassword("");
  }

  async function handleSignOut() {
    await signOutOfCloud();
    setApiKey("");
    setAccount(null);
    setBackendUrl(getConnectionConfig().backendUrl);
  }

  return (
    <div style={{ padding: 20, color: "#c9d1e0", maxWidth: 480 }}>
      <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 4 }}>Advanced Connection Settings</div>
      <div style={{ fontSize: 12, opacity: 0.6, marginBottom: 16 }}>
        Developers can point ORVYN at localhost, staging, or {ORVYN_CLOUD_URL}. Sign-in from the account menu uses the production cloud.
        Every panel shares this connection. Current account state: {stateLine}.
      </div>

      <label style={{ display: "block", fontSize: 11, opacity: 0.6, marginBottom: 4 }}>Backend URL</label>
      <input
        value={backendUrl}
        onChange={(e) => setBackendUrl(e.target.value)}
        placeholder="http://localhost:4570 or https://orvyn.yourdomain.com"
        style={inputStyle()}
      />

      <label style={{ display: "block", fontSize: 11, opacity: 0.6, marginBottom: 4, marginTop: 12 }}>
        API Key (required once the backend has ORVYN_API_KEY set — e.g. any cloud deployment)
      </label>
      <input value={apiKey} onChange={(e) => setApiKey(e.target.value)} type="password" style={inputStyle()} />

      <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
        <button onClick={handleSave} style={{ background: "#3b5bfd", border: "none", borderRadius: 6, color: "white", padding: "6px 14px", cursor: "pointer" }}>
          {saved ? "Saved ✓" : "Save"}
        </button>
        <button onClick={handleTest} disabled={status === "testing"} style={btnGhost()}>
          {status === "testing" ? "Testing…" : "Test Connection"}
        </button>
      </div>

      {status === "ok" && (
        <div style={{ marginTop: 12, padding: 10, borderRadius: 6, background: "#0f2418", border: "1px solid #1f5c3a", fontSize: 12 }}>
          ✓ Connected — {statusDetail}
        </div>
      )}
      {status === "error" && (
        <div style={{ marginTop: 12, padding: 10, borderRadius: 6, background: "#2a1420", border: "1px solid #4a2230", fontSize: 12 }}>
          ✗ Could not reach backend: {statusDetail}
        </div>
      )}

      <div style={{ marginTop: 20, fontSize: 11, opacity: 0.5 }}>
        Current: {getConnectionConfig().backendUrl || "(not set)"}
      </div>

      <div style={{ marginTop: 28, fontSize: 16, fontWeight: 700, marginBottom: 4 }}>Account</div>
      <div style={{ fontSize: 12, opacity: 0.6, marginBottom: 12 }}>
        Optional in local mode. Signing in gives you your own isolated workspace on the backend
        (models, missions, usage, settings) — required for shared or cloud deployments.
      </div>

      {account ? (
        <div style={{ padding: 12, borderRadius: 6, border: "1px solid #1c2330", background: "#0f1420" }}>
          <div style={{ fontSize: 13, fontWeight: 600 }}>{account.name || account.email}</div>
          <div style={{ fontSize: 11, opacity: 0.6, marginTop: 2 }}>{account.email}</div>
          <button onClick={handleSignOut} style={{ ...btnGhost(), marginTop: 10 }}>
            Sign out
          </button>
        </div>
      ) : (
        <div style={{ padding: 12, borderRadius: 6, border: "1px solid #1c2330", background: "#0f1420" }}>
          <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
            <button
              onClick={() => setAuthMode("signin")}
              style={{ ...btnGhost(), borderColor: authMode === "signin" ? "#3b5bfd" : "#2a3244" }}
            >
              Sign in
            </button>
            <button
              onClick={() => setAuthMode("register")}
              style={{ ...btnGhost(), borderColor: authMode === "register" ? "#3b5bfd" : "#2a3244" }}
            >
              Create account
            </button>
          </div>
          {authMode === "register" && (
            <>
              <label style={{ display: "block", fontSize: 11, opacity: 0.6, marginBottom: 4 }}>Name (optional)</label>
              <input value={authName} onChange={(e) => setAuthName(e.target.value)} style={{ ...inputStyle(), marginBottom: 8 }} />
            </>
          )}
          <label style={{ display: "block", fontSize: 11, opacity: 0.6, marginBottom: 4 }}>Email</label>
          <input value={authEmail} onChange={(e) => setAuthEmail(e.target.value)} style={{ ...inputStyle(), marginBottom: 8 }} />
          <label style={{ display: "block", fontSize: 11, opacity: 0.6, marginBottom: 4 }}>
            Password{authMode === "register" ? " (min 8 characters)" : ""}
          </label>
          <input
            value={authPassword}
            onChange={(e) => setAuthPassword(e.target.value)}
            type="password"
            style={{ ...inputStyle(), marginBottom: 10 }}
            onKeyDown={(e) => e.key === "Enter" && !authBusy && handleAuth()}
          />
          <button
            onClick={handleAuth}
            disabled={authBusy || !authEmail.trim() || !authPassword}
            style={{ background: "#3b5bfd", border: "none", borderRadius: 6, color: "white", padding: "6px 14px", cursor: "pointer", opacity: authBusy ? 0.6 : 1 }}
          >
            {authBusy ? "Working…" : authMode === "register" ? "Create account" : "Sign in"}
          </button>
          {authError && (
            <div style={{ marginTop: 8, padding: 8, borderRadius: 6, background: "#2a1420", border: "1px solid #4a2230", fontSize: 12 }}>
              {authError}
            </div>
          )}
        </div>
      )}

      <div style={{ marginTop: 28, fontSize: 16, fontWeight: 700, marginBottom: 4 }}>Autonomy profile</div>
      <div style={{ fontSize: 12, opacity: 0.6, marginBottom: 12 }}>
        How much agents may do without asking. Destructive shell commands always
        require approval, and per-tool overrides in the Tools list still win.
      </div>
      {profiles.map((p) => (
        <label
          key={p.id}
          style={{
            display: "flex",
            gap: 10,
            alignItems: "flex-start",
            padding: "8px 10px",
            borderRadius: 6,
            border: `1px solid ${profile === p.id ? "#3b5bfd" : "#1c2330"}`,
            marginBottom: 8,
            cursor: "pointer",
            background: profile === p.id ? "#131a2e" : "transparent",
          }}
        >
          <input
            type="radio"
            name="autonomy-profile"
            checked={profile === p.id}
            onChange={() => selectProfile(p.id)}
            style={{ marginTop: 2 }}
          />
          <span>
            <span style={{ fontSize: 13, fontWeight: 600 }}>{p.label}</span>
            <span style={{ display: "block", fontSize: 11, opacity: 0.6, marginTop: 2 }}>{p.description}</span>
          </span>
        </label>
      ))}
      {profileError && (
        <div style={{ marginTop: 8, padding: 10, borderRadius: 6, background: "#2a1420", border: "1px solid #4a2230", fontSize: 12 }}>
          {profileError}
        </div>
      )}
    </div>
  );
}

function inputStyle(): React.CSSProperties {
  return { width: "100%", background: "#0f1420", border: "1px solid #1c2330", borderRadius: 6, color: "#e6e9f0", padding: "6px 10px", fontSize: 13 };
}

function btnGhost(): React.CSSProperties {
  return { background: "transparent", border: "1px solid #2a3244", borderRadius: 6, color: "#c9d1e0", padding: "6px 14px", fontSize: 13, cursor: "pointer" };
}
