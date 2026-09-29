import { useEffect, useState } from "react";
import { api, ApiError } from "../lib/api";
import { useStore } from "../lib/store";
import { navigate, useLocation } from "../lib/router";
import { Orb } from "../components/Orb";
import { surface } from "../lib/surface";
import { Icon } from "../components/Icons";

// Sign in / create account / reset password. Google and GitHub finish through a
// handoff: the portal keeps a secret verifier in this tab and claims the
// session with it — no session token ever appears in a URL.

type Mode = "login" | "register" | "forgot";
interface Providers { google: boolean; github: boolean; email: boolean }

const HANDOFF_KEY = "orvyn.handoff";

function b64url(bytes: Uint8Array): string {
  let s = "";
  bytes.forEach((b) => { s += String.fromCharCode(b); });
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function randomId(n: number): string { const b = new Uint8Array(n); crypto.getRandomValues(b); return b64url(b); }

async function startProvider(provider: "google" | "github") {
  const hid = randomId(24);
  const verifier = randomId(32);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  try { sessionStorage.setItem(HANDOFF_KEY, JSON.stringify({ hid, verifier })); } catch { /* storage off: the claim will fail and say so */ }
  location.href = `/api/v1/auth/oauth/${provider}/start?client=web&hid=${encodeURIComponent(hid)}&challenge=${encodeURIComponent(b64url(digest))}`;
}

export function SignIn() {
  const { signIn } = useStore();
  const { query } = useLocation();
  const [mode, setMode] = useState<Mode>(query.get("mode") === "register" ? "register" : "login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [providers, setProviders] = useState<Providers>({ google: false, github: false, email: false });

  useEffect(() => { api<Providers>("/onboarding/providers").then(setProviders).catch(() => undefined); }, []);

  // Back from Google/GitHub: claim the session with the verifier kept in this tab.
  const complete = query.get("complete");
  useEffect(() => {
    if (!complete) return;
    let saved: { hid: string; verifier: string } | null = null;
    try { saved = JSON.parse(sessionStorage.getItem(HANDOFF_KEY) || "null"); } catch { saved = null; }
    if (!saved || saved.hid !== complete) { setError("That sign-in started in another tab or expired. Try again."); navigate("/signin", { replace: true }); return; }
    setBusy(true);
    api<{ status: string; token?: string; error?: string }>("/auth/handoff/claim", { method: "POST", body: saved })
      .then(async (r) => {
        try { sessionStorage.removeItem(HANDOFF_KEY); } catch { /* */ }
        if (r.token) { navigate("/", { replace: true }); await signIn(r.token); }
        else setError("Sign-in didn't finish. Try again.");
      })
      .catch((e: ApiError) => setError(e.message))
      .finally(() => setBusy(false));
  }, [complete, signIn]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null); setNotice(null); setBusy(true);
    try {
      if (mode === "forgot") {
        const r = await api<{ message: string }>("/auth/password/forgot", { method: "POST", body: { email } });
        setNotice(r.message);
      } else {
        const r = await api<{ token: string }>(mode === "login" ? "/auth/login" : "/auth/register", { method: "POST", body: mode === "login" ? { email, password } : { email, password, name: name || undefined } });
        await signIn(r.token);
      }
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const title = mode === "login" ? (surface === "admin" ? "ORVYN Admin Portal" : "Sign in to ORVYN") : mode === "register" ? "Create your ORVYN account" : "Reset your password";
  return (
    <div className="auth">
      <div className="card auth__card">
        <div className="auth__orb"><Orb /></div>
        <h1>{title}</h1>
        <p className="sub">{mode === "forgot" ? "We'll email you a link to choose a new password." : surface === "admin" ? "Staff sign-in. Access is limited to ORVYN staff." : "One account for ORVYN Cloud and ORVYN Desktop."}</p>
        {mode !== "forgot" && (providers.google || providers.github) ? (
          <>
            <div className="auth__social">
              {providers.google ? <button className="btn" onClick={() => void startProvider("google")} disabled={busy}><Icon.google /> Continue with Google</button> : null}
              {providers.github ? <button className="btn" onClick={() => void startProvider("github")} disabled={busy}><Icon.github /> Continue with GitHub</button> : null}
            </div>
            <div className="auth__or">or with email</div>
          </>
        ) : null}
        <form onSubmit={submit}>
          {mode === "register" ? (
            <div className="field"><label htmlFor="name">Name</label><input id="name" className="input" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" /></div>
          ) : null}
          <div className="field"><label htmlFor="email">Email</label><input id="email" className="input" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" /></div>
          {mode !== "forgot" ? (
            <div className="field"><label htmlFor="password">Password</label><input id="password" className="input" type="password" required minLength={mode === "register" ? 8 : 1} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={mode === "login" ? "current-password" : "new-password"} /></div>
          ) : null}
          {error ? <div className="error" role="alert">{error}</div> : null}
          {notice ? <div className="notice">{notice}</div> : null}
          <button className="btn btn--primary btn--big" type="submit" disabled={busy} data-testid="auth-submit">
            {busy ? "Please wait…" : mode === "login" ? "Sign in" : mode === "register" ? "Create account" : "Send reset link"}
          </button>
        </form>
        <div className="auth__links">
          {mode === "login" ? <button className="linkbtn" onClick={() => { setMode("forgot"); setError(null); }}>Forgot password?</button> : <button className="linkbtn" onClick={() => { setMode("login"); setError(null); setNotice(null); }}>Back to sign in</button>}
          {mode !== "register" && surface !== "admin" ? <button className="linkbtn" onClick={() => { setMode("register"); setError(null); setNotice(null); }}>Create an account</button> : null}
        </div>
      </div>
    </div>
  );
}

/** A new account finishes the same setup Desktop requires before it can use ORVYN. */
export function FinishSetup() {
  const { me, gate, refresh, signOut } = useStore();
  const [name, setName] = useState(me?.user.name ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  const verifying = gate === "EMAIL_NOT_VERIFIED";

  useEffect(() => {
    if (!verifying) return;
    const t = window.setInterval(async () => {
      try { const s = await api<{ verified: boolean }>("/auth/verification/status"); if (s.verified) await refresh(); } catch { /* try again */ }
    }, 4000);
    return () => window.clearInterval(t);
  }, [verifying, refresh]);

  const finish = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      await api("/onboarding/provision", { method: "POST", body: {} });
      await api("/onboarding", { method: "PUT", body: { step: "complete", answers: { name: name.trim() || undefined }, completed: ["name"] } });
      await refresh();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth">
      <div className="card auth__card">
        <div className="auth__orb"><Orb /></div>
        {verifying ? (
          <>
            <h1>Check your inbox</h1>
            <p className="sub">We sent a link to <b>{me?.user.email}</b>. Open it to confirm your email — this page continues on its own.</p>
            {sent ? <div className="notice">{sent}</div> : null}
            <button className="btn btn--big" disabled={busy} onClick={async () => {
              setBusy(true);
              try { const r = await api<{ sent: boolean; verified?: boolean }>("/auth/verification/resend", { method: "POST", body: {} }); setSent(r.verified ? "Already verified." : r.sent ? "Sent again." : "Please wait a minute before asking again."); if (r.verified) await refresh(); }
              catch (err: any) { setSent(err.message); }
              finally { setBusy(false); }
            }}>Resend email</button>
          </>
        ) : (
          <form onSubmit={finish}>
            <h1>Finish setting up</h1>
            <p className="sub">Your ORVYN workspace is almost ready.</p>
            <div className="field"><label htmlFor="setup-name">What should ORVYN call you?</label><input id="setup-name" className="input" value={name} onChange={(e) => setName(e.target.value)} /></div>
            {error ? <div className="error" role="alert">{error}</div> : null}
            <button className="btn btn--primary btn--big" type="submit" disabled={busy} data-testid="finish-setup">{busy ? "Setting up…" : "Enter ORVYN Cloud"}</button>
          </form>
        )}
        <div className="auth__links"><span /><button className="linkbtn" onClick={() => void signOut()}>Sign out</button></div>
      </div>
    </div>
  );
}
