import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "../lib/api";
import { useStore } from "../lib/store";
import { navigate, useLocation } from "../lib/router";
import { Orb } from "../components/Orb";
import { surface } from "../lib/surface";
import { Icon } from "../components/Icons";
import { Markdown } from "../lib/markdown";
import { mobilePlatform } from "../lib/mobilePlatform";
import { mobileSignIn } from "../lib/mobileAuth";

// Sign in / create account / reset password. Google and GitHub finish through a
// handoff: the portal keeps a secret verifier in this tab and claims the
// session with it — no session token ever appears in a URL.

type Mode = "login" | "register" | "forgot";
interface Providers { google: boolean; github: boolean; email: boolean; termsUrl?: string | null; privacyUrl?: string | null }
interface LegalDocument { id: string; title: string; requiredForAcceptance: boolean; content: string }
interface LegalBundle { version: string; documents: LegalDocument[] }

/** Same rule as ORVYN Desktop's sign-up meter; the web asks for at least "Fair". */
export function passwordStrength(pw: string): { score: number; label: string; ok: boolean } {
  let score = 0;
  if (pw.length >= 8) score++;
  if (pw.length >= 12) score++;
  if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) score++;
  if (/\d/.test(pw) && /[^A-Za-z0-9]/.test(pw)) score++;
  const labels = ["Too short", "Weak", "Fair", "Good", "Strong"];
  return { score, label: pw.length < 8 ? "At least 8 characters" : labels[score]!, ok: pw.length >= 8 && score >= 2 };
}

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
  const nativeClaim = useRef<AbortController | null>(null);
  useEffect(() => () => nativeClaim.current?.abort(), []);
  const { query } = useLocation();
  const [mode, setMode] = useState<Mode>(query.get("mode") === "register" ? "register" : "login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [first, setFirst] = useState("");
  const [last, setLast] = useState("");
  const [company, setCompany] = useState("");
  const [confirm, setConfirm] = useState("");
  const [terms, setTerms] = useState(false);
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [providers, setProviders] = useState<Providers>({ google: false, github: false, email: false });
  const [legal, setLegal] = useState<LegalBundle | null>(null);

  useEffect(() => {
    api<Providers>("/onboarding/providers").then(setProviders).catch(() => undefined);
    api<LegalBundle>("/auth/legal").then(setLegal).catch(() => setLegal(null));
  }, []);

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

  const beginProvider = async (provider: "google" | "github") => {
    setError(null);
    if (!mobilePlatform()) {
      try { await startProvider(provider); } catch (err) { setError(err instanceof Error ? err.message : "Sign-in could not start."); }
      return;
    }
    nativeClaim.current?.abort();
    const controller = new AbortController();
    nativeClaim.current = controller;
    setBusy(true);
    try { await signIn(await mobileSignIn(provider, controller.signal)); }
    catch (err) { if (!controller.signal.aborted) setError(err instanceof Error ? err.message : "Sign-in failed."); }
    finally { if (!controller.signal.aborted) setBusy(false); }
  };

  const strength = passwordStrength(password);
  const registerProblem = (): string | null => {
    if (!first.trim() || !last.trim()) return "Enter your first and last name.";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) return "Enter a valid email address.";
    if (!strength.ok) return "Choose a stronger password: at least 12 characters, or mix upper and lower case, numbers and symbols.";
    if (password !== confirm) return "The passwords don't match.";
    if (!terms) return "Agree to the current ORVYN legal documents to continue.";
    if (!legal?.version) return "ORVYN's current legal documents haven't loaded. Refresh and try again.";
    return null;
  };
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null); setNotice(null);
    if (mode === "register") { const p = registerProblem(); if (p) { setError(p); return; } }
    setBusy(true);
    try {
      if (mode === "forgot") {
        const r = await api<{ message: string }>("/auth/password/forgot", { method: "POST", body: { email } });
        setNotice(r.message);
      } else {
        const r = await api<{ token: string }>(mode === "login" ? "/auth/login" : "/auth/register", { method: "POST", body: mode === "login" ? { email, password } : { email: email.trim(), password, name: `${first.trim()} ${last.trim()}`, organization: company.trim() || undefined, legalAccepted: terms, legalVersion: legal!.version, acceptTerms: terms, client: mobilePlatform() ? "mobile" : "web" } });
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
        <p className="sub">{mode === "forgot" ? "We'll email you a link to choose a new password." : surface === "admin" ? "Staff sign-in. Access is limited to ORVYN staff." : "One account for ORVYN Cloud, Desktop, and Mobile."}</p>
        {mode !== "forgot" && surface !== "admin" ? (
          <>
            <div className="auth__social">
              <button className="btn" onClick={() => void beginProvider("google")} disabled={busy || !providers.google} title={providers.google ? undefined : "Google sign-in isn't switched on for this server yet"} data-testid="oauth-google"><Icon.google /> Continue with Google</button>
              <button className="btn" onClick={() => void beginProvider("github")} disabled={busy || !providers.github} title={providers.github ? undefined : "GitHub sign-in isn't switched on for this server yet"} data-testid="oauth-github"><Icon.github /> Continue with GitHub</button>
              {!providers.google || !providers.github ? <div className="faint" style={{ fontSize: 12, textAlign: "center" }}>{!providers.google && !providers.github ? "Google and GitHub sign-in aren't switched on for this server yet." : `${!providers.google ? "Google" : "GitHub"} sign-in isn't switched on for this server yet.`}</div> : null}
            </div>
            <div className="auth__or">or with email</div>
          </>
        ) : null}
        <form onSubmit={submit}>
          {mode === "register" ? (
            <>
              <div className="two" style={{ gap: 10 }}>
                <div className="field"><label htmlFor="first">First name *</label><input id="first" className="input" required value={first} onChange={(e) => setFirst(e.target.value)} autoComplete="given-name" /></div>
                <div className="field"><label htmlFor="last">Last name *</label><input id="last" className="input" required value={last} onChange={(e) => setLast(e.target.value)} autoComplete="family-name" /></div>
              </div>
              <div className="field"><label htmlFor="company">Company <span className="faint">(optional)</span></label><input id="company" className="input" value={company} onChange={(e) => setCompany(e.target.value)} autoComplete="organization" /></div>
            </>
          ) : null}
          <div className="field"><label htmlFor="email">Email{mode === "register" ? " *" : ""}</label><input id="email" className="input" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" /></div>
          {mode !== "forgot" ? (
            <div className="field"><label htmlFor="password">Password{mode === "register" ? " *" : ""}</label>
              <div style={{ position: "relative" }}>
                <input id="password" className="input" style={{ width: "100%", paddingRight: 64 }} type={show ? "text" : "password"} required value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={mode === "login" ? "current-password" : "new-password"} />
                <button type="button" className="linkbtn" style={{ position: "absolute", right: 12, top: 13 }} onClick={() => setShow((v) => !v)}>{show ? "Hide" : "Show"}</button>
              </div>
              {mode === "register" && password ? <div className="pw-meter" aria-live="polite"><span>{[0, 1, 2, 3].map((i) => <i key={i} className={i < strength.score ? "on" : ""} />)}</span>{strength.label}</div> : null}
            </div>
          ) : null}
          {mode === "register" ? (
            <>
              <div className="field"><label htmlFor="confirm">Confirm password *</label><input id="confirm" className="input" type={show ? "text" : "password"} required value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" aria-invalid={Boolean(confirm) && confirm !== password} /></div>
              <label className="terms"><input type="checkbox" checked={terms} onChange={(e) => setTerms(e.target.checked)} data-testid="accept-terms" /> <span>I agree to the current ORVYN Software License, Privacy Policy, Acceptable Use Policy, and AI &amp; Agent Disclosure{legal?.version ? " (version " + legal.version + ")" : ""}.</span></label>
              {legal ? (
                <details className="terms-review" data-testid="legal-review">
                  <summary>Review required legal documents</summary>
                  <div style={{ maxHeight: 320, overflowY: "auto", display: "grid", gap: 12, padding: "10px 4px" }}>
                    {legal.documents.filter((document) => document.requiredForAcceptance).map((document) => (
                      <details key={document.id}>
                        <summary>{document.title}</summary>
                        <div className="markdown" style={{ padding: "10px 2px" }}><Markdown text={document.content} /></div>
                      </details>
                    ))}
                  </div>
                </details>
              ) : null}
            </>
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
