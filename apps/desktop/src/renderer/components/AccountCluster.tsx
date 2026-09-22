// Title-bar account control. Labels come from the shared connection runtime.
import React, { useEffect, useState } from "react";
import { describeConnection, type ConnectionPresentation } from "../connectionState";
import { getConnectionFacts, onConnectionFacts, signInWithCredentials, signOutOfCloud, continueInLocalMode } from "../connectionRuntime";

export function AccountCluster({
  onOpenSettings,
  onSwitchWorkspace,
}: {
  onOpenSettings?: () => void;
  onSwitchWorkspace?: () => void;
}) {
  const [view, setView] = useState<ConnectionPresentation>(() => describeConnection(getConnectionFacts()));
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"menu" | "signin" | "register">("menu");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => onConnectionFacts((facts) => setView(describeConnection(facts))), []);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const initial = (view.signedIn ? view.userName : "O").charAt(0).toUpperCase();
  const dot = view.showTitleDot ? view.titleDot : view.state === "connecting" ? "pending" : "off";

  async function submit() {
    setError("");
    setBusy(true);
    const result = await signInWithCredentials({
      email,
      password,
      name,
      mode: mode === "register" ? "register" : "login",
    });
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setPassword("");
    setOpen(false);
    setMode("menu");
  }

  return (
    <div style={{ position: "relative" }} className="no-drag">
      <button
        type="button"
        className="no-drag"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => {
          setOpen((v) => !v);
          setMode(view.state === "session-expired" ? "signin" : "menu");
          setError("");
        }}
        title={view.signedIn ? view.menuStatus : "Connect account"}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 8,
          background: "transparent",
          border: "none",
          padding: 0,
          cursor: "pointer",
          color: "inherit",
        }}
      >
        <span
          style={{
            width: 24,
            height: 24,
            borderRadius: "50%",
            background: "linear-gradient(135deg, #6C5CFF, #22D3EE)",
            color: "#fff",
            fontSize: 10.5,
            fontWeight: 700,
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          {initial}
        </span>
        <span style={{ display: "flex", flexDirection: "column", lineHeight: 1.15, marginRight: 4, textAlign: "left" }}>
          <span style={{ fontSize: 11, color: "var(--orvyn-text)", display: "inline-flex", alignItems: "center", gap: 5 }}>
            {view.showTitleDot && (
              <span style={{ width: 6, height: 6, borderRadius: "50%", background: dotColor(dot) }} />
            )}
            {view.titlePrimary}
          </span>
          <span style={{ fontSize: 9.5, color: "var(--orvyn-text-muted)" }}>
            {view.signedIn || view.state === "local" || view.state === "signed-out" ? `${view.titleSecondary} ▾` : view.titleSecondary}
          </span>
        </span>
      </button>

      {open && (
        <div
          role="menu"
          style={{
            position: "absolute",
            top: 36,
            right: 0,
            width: 280,
            background: "var(--bg-elevated)",
            border: "1px solid var(--border-strong)",
            borderRadius: 8,
            boxShadow: "var(--orvyn-shadow)",
            padding: 10,
            zIndex: 600,
          }}
        >
          {view.signedIn && mode === "menu" ? (
            <SignedInMenu
              view={view}
              onSettings={() => {
                setOpen(false);
                onOpenSettings?.();
              }}
              onConnection={() => {
                setOpen(false);
                onOpenSettings?.();
              }}
              onWorkspace={() => {
                setOpen(false);
                onSwitchWorkspace?.();
              }}
              onSignOut={() => {
                setOpen(false);
                void signOutOfCloud();
              }}
            />
          ) : mode === "signin" || mode === "register" ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (!busy) void submit();
              }}
            >
              <div style={{ fontSize: 13, fontWeight: 650, marginBottom: 8 }}>
                {mode === "register" ? "Create ORVYN account" : "Sign in to ORVYN Cloud"}
              </div>
              {mode === "register" && (
                <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" style={fieldStyle} />
              )}
              <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Email" autoComplete="username" style={fieldStyle} />
              <input
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Password"
                type="password"
                autoComplete={mode === "register" ? "new-password" : "current-password"}
                style={fieldStyle}
              />
              {error && <div style={{ color: "#f0a8b4", fontSize: 11, marginBottom: 8 }}>{error}</div>}
              <button type="submit" disabled={busy || !email.trim() || !password} style={primaryBtn}>
                {busy ? "Working…" : mode === "register" ? "Create account" : "Sign in"}
              </button>
              <button type="button" onClick={() => setMode("menu")} style={ghostBtn}>
                Back
              </button>
            </form>
          ) : (
            <>
              <div style={{ fontSize: 13, fontWeight: 650, marginBottom: 4 }}>Connect to ORVYN Cloud</div>
              <div style={{ fontSize: 11, color: "var(--orvyn-text-muted)", marginBottom: 10 }}>
                Local projects, models, and history stay on this machine.
              </div>
              <button type="button" onClick={() => setMode("signin")} style={primaryBtn}>
                Sign in
              </button>
              <button type="button" onClick={() => setMode("register")} style={ghostBtn}>
                Create account
              </button>
              <div style={{ height: 1, background: "var(--border)", margin: "8px 0" }} />
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  void continueInLocalMode();
                }}
                style={ghostBtn}
              >
                Continue in Local Mode
              </button>
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  onOpenSettings?.();
                }}
                style={ghostBtn}
              >
                Advanced Connection Settings
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function SignedInMenu({
  view,
  onSettings,
  onConnection,
  onWorkspace,
  onSignOut,
}: {
  view: ConnectionPresentation;
  onSettings: () => void;
  onConnection: () => void;
  onWorkspace: () => void;
  onSignOut: () => void;
}) {
  const factsEmail = view.userName;
  return (
    <>
      <div style={{ fontSize: 13, fontWeight: 650 }}>
        {factsEmail}
        {view.accountEmail ? <span style={{ fontWeight: 450, color: "var(--orvyn-text-muted)" }}> {view.accountEmail}</span> : null}
      </div>
      <div style={{ fontSize: 11, color: "var(--orvyn-text-muted)", marginTop: 2, marginBottom: 8 }}>● {view.menuStatus}</div>
      <div style={{ fontSize: 11, marginBottom: 8 }}>Workspace: {view.workspaceLabel}</div>
      <button type="button" onClick={onSettings} style={ghostBtn}>
        Account Settings
      </button>
      <button type="button" onClick={onConnection} style={ghostBtn}>
        Connection
      </button>
      <button type="button" onClick={onWorkspace} style={ghostBtn}>
        Switch Workspace
      </button>
      <div style={{ height: 1, background: "var(--border)", margin: "8px 0" }} />
      <button type="button" onClick={onSignOut} style={ghostBtn}>
        Sign Out
      </button>
    </>
  );
}

function dotColor(dot: "on" | "off" | "pending"): string {
  if (dot === "on") return "var(--orvyn-green)";
  if (dot === "pending") return "var(--orvyn-amber, #e6b35a)";
  return "var(--orvyn-text-muted)";
}

const fieldStyle: React.CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  background: "var(--orvyn-surface-2, #0f1420)",
  border: "1px solid var(--border)",
  borderRadius: 6,
  color: "var(--orvyn-text, #e6e9f0)",
  padding: "6px 8px",
  fontSize: 12,
  marginBottom: 8,
};

const primaryBtn: React.CSSProperties = {
  width: "100%",
  background: "#3b5bfd",
  border: "none",
  borderRadius: 6,
  color: "white",
  padding: "6px 10px",
  fontSize: 12,
  cursor: "pointer",
  marginBottom: 6,
};

const ghostBtn: React.CSSProperties = {
  width: "100%",
  background: "transparent",
  border: "none",
  borderRadius: 6,
  color: "var(--orvyn-text, #c9d1e0)",
  padding: "6px 8px",
  fontSize: 12,
  cursor: "pointer",
  textAlign: "left",
};
