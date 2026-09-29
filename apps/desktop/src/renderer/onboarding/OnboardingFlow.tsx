// apps/desktop/src/renderer/onboarding/OnboardingFlow.tsx
//
// ORVYN onboarding: a full-screen mode of its own (no sidebar, no chats, no
// panels). Every screen reads and writes the server's onboarding state
// (/api/v1/onboarding), so the same step resumes on web or desktop and after
// a restart. Checkmarks on "Setting up your workspace" come from the server
// checking real state. If the server is unreachable, answers are kept in a
// local draft and synced when it is back; the server stays authoritative.

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import orvynMark from "../assets/icon.png";
import { OnboardingOrb, type OrbState } from "./OnboardingOrb";
import {
  FIRST_MISSIONS,
  GOAL_OPTIONS,
  PRIMARY_USE_OPTIONS,
  RESPONSE_STYLE_OPTIONS,
  STEPS,
  WORKSPACE_OPTIONS,
  WORK_STYLE_OPTIONS,
  clearDraft,
  loadDraft,
  mergeDraft,
  nextStep,
  passwordStrength,
  previousStep,
  progressSegments,
  recapRows,
  saveDraft,
  validEmail,
  type Answers,
  type Profile,
  type Step,
} from "./onboardingModel";
import { LOCAL_BACKEND_URL, ORVYN_CLOUD_URL, getConnectionConfig, isSessionToken, secureBackendUrl } from "../connection";
import { adoptBrowserSession, signInWithCredentials } from "../connectionRuntime";
import "./onboarding.css";

interface ProvisionLine { id: string; label: string; done: boolean; detail?: string }
interface PlanView { id: string; label: string; priceMonthlyUsd: number | null; priceAnnualUsd: number | null; monthlyCredits: number; rolling5h: number; rolling7d: number; parallelAgents: number; projects: number | null; features: { premiumModels: string; ssh: string; deployments: string; apiAccess: boolean } }
interface ServerView {
  profile: Profile;
  user: { id: string; email: string; name: string | null; emailVerified: boolean };
  verificationRequired: boolean;
  provisioning: ProvisionLine[];
  plan: PlanView | null;
}
interface Providers { email: boolean; google: boolean; github: boolean; checkout: boolean }

export interface OnboardingResult {
  mission?: { prompt: string; mode: string; projectRoot?: string | null };
}

let accountOverride: string | null = null;
/** Staging/test account server (from the main process). */
export function setAccountServer(url: string | null): void {
  accountOverride = url;
}

/** Where accounts live: the saved ORVYN Cloud (or staging) backend; the local engine never holds accounts. */
function accountBase(): string {
  if (accountOverride) return secureBackendUrl(accountOverride);
  const cfg = getConnectionConfig();
  if (cfg.backendUrl && cfg.backendUrl.replace(/\/$/, "") !== LOCAL_BACKEND_URL) return secureBackendUrl(cfg.backendUrl);
  return secureBackendUrl(ORVYN_CLOUD_URL);
}

async function call<T = any>(path: string, init: { method?: string; body?: unknown } = {}): Promise<{ ok: boolean; status: number; data: T }> {
  const cfg = getConnectionConfig();
  const base = isSessionToken(cfg.apiKey) ? secureBackendUrl(cfg.backendUrl) : accountBase();
  const res = await fetch(`${base}/api/v1${path}`, {
    method: init.method ?? "GET",
    headers: { "Content-Type": "application/json", ...(isSessionToken(cfg.apiKey) ? { Authorization: `Bearer ${cfg.apiKey}` } : {}) },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data: data as T };
}

const track = (name: string, props: Record<string, string | number | boolean> = {}) => {
  void call("/onboarding/event", { method: "POST", body: { name, props } }).catch(() => undefined);
};

// ---------- icons (thin line, one weight) ----------
const I = {
  path: (d: string, size = 20) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>
  ),
};
const ICON: Record<string, React.ReactNode> = {
  code: I.path("M8 8l-4 4 4 4M16 8l4 4-4 4M13.5 5l-3 14"),
  server: I.path("M4 5h16v5H4zM4 14h16v5H4zM8 7.5h.01M8 16.5h.01"),
  search: I.path("M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-4.2-4.2"),
  briefcase: I.path("M4 8h16v11H4zM9 8V5h6v3M4 13h16"),
  gear: I.path("M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 13a7.6 7.6 0 0 0 0-2l2-1.5-2-3.4-2.4 1a7.4 7.4 0 0 0-1.7-1L15 3.5h-4l-.3 2.6a7.4 7.4 0 0 0-1.7 1l-2.4-1-2 3.4 2 1.5a7.6 7.6 0 0 0 0 2l-2 1.5 2 3.4 2.4-1c.5.4 1.1.8 1.7 1l.3 2.6h4l.3-2.6c.6-.2 1.2-.6 1.7-1l2.4 1 2-3.4z"),
  spark: I.path("M12 3v5M12 16v5M3 12h5M16 12h5M6 6l3 3M15 15l3 3M18 6l-3 3M9 15l-3 3"),
  plan: I.path("M7 4h10v17H7zM10 8h4M10 12h4M10 16h2"),
  bolt: I.path("M13 3L5 14h6l-1 7 8-11h-6z"),
  adapt: I.path("M4 12a8 8 0 0 1 14-5.3M20 12a8 8 0 0 1-14 5.3M18 3v4h-4M6 21v-4h4"),
  concise: I.path("M5 8h14M5 12h9M5 16h6"),
  balanced: I.path("M5 7h14M5 12h14M5 17h10"),
  detailed: I.path("M5 5h14M5 9h14M5 13h14M5 17h14M5 21h8"),
  plus: I.path("M12 5v14M5 12h14"),
  folder: I.path("M3 7h6l2 2h10v10H3z"),
  git: I.path("M6 3v12M6 15a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 9c0 6-12 3-12 6"),
  github: I.path("M9 19c-4 1.5-4-2-6-2.5M15 22v-3.5c0-1 .1-1.4-.5-2 2.8-.3 5.5-1.4 5.5-6a4.6 4.6 0 0 0-1.3-3.2 4.2 4.2 0 0 0-.1-3.2s-1-.3-3.4 1.3a11.6 11.6 0 0 0-6.2 0C6.6 3.8 5.6 4.1 5.6 4.1a4.2 4.2 0 0 0-.1 3.2A4.6 4.6 0 0 0 4.2 10.5c0 4.6 2.7 5.7 5.5 6-.6.6-.6 1.2-.5 2V22"),
  none: I.path("M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM5.6 5.6l12.8 12.8"),
  user: I.path("M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0"),
  mail: I.path("M3 6h18v12H3zM3 7l9 6 9-6"),
  lock: I.path("M5 11h14v10H5zM8 11V7a4 4 0 0 1 8 0v4"),
  eye: I.path("M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z"),
  eyeOff: I.path("M3 3l18 18M10.6 10.6a2 2 0 0 0 2.8 2.8M9.9 5.1A10.4 10.4 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.2 4.2M6.1 6.1A17.6 17.6 0 0 0 2 12s3.5 7 10 7a10 10 0 0 0 5.9-1.9"),
  check: I.path("M5 12.5l4.5 4.5L19 7.5", 14),
  arrow: I.path("M5 12h14M13 6l6 6-6 6", 18),
  memory: I.path("M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3zM4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"),
  google: (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path fill="#EA4335" d="M12 10.2v3.9h5.5c-.2 1.3-1.6 3.9-5.5 3.9-3.3 0-6-2.7-6-6.1s2.7-6.1 6-6.1c1.9 0 3.2.8 3.9 1.5l2.7-2.6C16.9 3.1 14.7 2 12 2 6.5 2 2 6.5 2 12s4.5 10 10 10c5.8 0 9.6-4.1 9.6-9.8 0-.7-.1-1.2-.2-1.7z" /></svg>
  ),
};

const WORKSPACE_ICON: Record<string, string> = { new_project: "plus", local_folder: "folder", clone_repo: "git", github: "github", none: "none" };
const RECAP_ICON: Record<string, string> = { name: "user", primary_use: "briefcase", goals: "spark", work_style: "plan", response_style: "concise", memory: "memory", workspace: "folder", github: "github" };

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function Check({ on }: { on: boolean }) {
  return <span className="ob-check" aria-hidden="true">{on ? ICON.check : null}</span>;
}

export function OnboardingFlow({ onDone, signedIn }: { onDone: (r: OnboardingResult) => void; signedIn: boolean }) {
  const [step, setStep] = useState<Step>(signedIn ? "provisioning" : "welcome");
  const [answers, setAnswers] = useState<Answers>({ workStyle: "adaptive", responseStyle: "adaptive", memory: true });
  const [completed, setCompleted] = useState<Step[]>([]);
  const [view, setView] = useState<ServerView | null>(null);
  const [providers, setProviders] = useState<Providers>({ email: true, google: false, github: false, checkout: false });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [offline, setOffline] = useState(false);
  const [returnToRecap, setReturnToRecap] = useState(false);
  const [signinFirst, setSigninFirst] = useState(false);
  const [orb, setOrb] = useState<OrbState>(signedIn ? "idle" : "awakening");
  const loadedRef = useRef(false);

  // Load the server's state (resume at the same step on any device).
  const refresh = useCallback(async (): Promise<ServerView | null> => {
    try {
      const r = await call<ServerView>("/onboarding");
      if (!r.ok) return null;
      setView(r.data);
      setOffline(false);
      return r.data;
    } catch {
      setOffline(true);
      return null;
    }
  }, []);

  useEffect(() => {
    void call<Providers>("/onboarding/providers").then((r) => { if (r.ok) setProviders(r.data); }).catch(() => undefined);
    if (!signedIn) { track("onboarding_started"); return; }
    void (async () => {
      const v = await refresh();
      const draft = loadDraft();
      if (v) {
        const merged = mergeDraft(v.profile, draft);
        setStep(merged.step);
        setAnswers((a) => ({ ...a, ...merged.answers }));
        setCompleted(merged.completed);
        if (merged.needsSync) void sync(merged.step, merged.completed, merged.answers);
        else clearDraft();
      } else if (draft) {
        setStep(draft.step);
        setAnswers((a) => ({ ...a, ...draft.answers }));
        setCompleted(draft.completed);
      }
      loadedRef.current = true;
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signedIn]);

  useEffect(() => {
    if (step !== "welcome") setOrb((o) => (o === "awakening" ? "idle" : o));
    const t = window.setTimeout(() => setOrb((o) => (o === "awakening" ? "idle" : o)), 1900);
    return () => window.clearTimeout(t);
  }, [step]);

  const sync = useCallback(async (to: Step, done: Step[], a: Answers): Promise<boolean> => {
    try {
      const r = await call<ServerView & { code?: string; error?: string }>("/onboarding", { method: "PUT", body: { step: to, completed: done, answers: a } });
      if (r.ok) {
        setView(r.data);
        setOffline(false);
        clearDraft();
        return true;
      }
      if (r.status === 409) {
        setView(r.data);
        setStep(r.data.profile.currentStep);
        setError(r.data.error ?? "");
        return false;
      }
      throw new Error(`HTTP ${r.status}`);
    } catch {
      // Keep the user's choices; sync when the server is back.
      saveDraft({ step: to, answers: a, completed: done });
      setOffline(true);
      return true;
    }
  }, []);

  // Offline: retry the sync every few seconds.
  useEffect(() => {
    if (!offline) return;
    const t = window.setInterval(() => {
      const d = loadDraft();
      if (d) void sync(d.step, d.completed, d.answers);
      else void refresh();
    }, 5000);
    return () => window.clearInterval(t);
  }, [offline, sync, refresh]);

  useEffect(() => {
    if (step !== "welcome" && step !== "signup") track("onboarding_step_viewed", { step });
  }, [step]);

  /** Save this step's answers and move on (Recap edits return to the Recap). */
  async function advance(patch: Partial<Answers> = {}, to?: Step) {
    setError("");
    const next = to ?? (returnToRecap ? "recap" : nextStep(step));
    const a = { ...answers, ...patch };
    const done = [...new Set([...completed, step])] as Step[];
    setAnswers(a);
    setBusy(true);
    const ok = await sync(next, done, a);
    setBusy(false);
    if (!ok) return;
    setCompleted(done);
    setReturnToRecap(false);
    setStep(next);
  }

  function back() {
    setError("");
    if (returnToRecap) { setReturnToRecap(false); setStep("recap"); return; }
    const prev = previousStep(step);
    if (prev) setStep(prev);
  }

  // Finished on another device (or resumed at "complete"): open ORVYN.
  useEffect(() => { if (step === "complete") onDone({}); }, [step, onDone]);

  const segments = useMemo(() => progressSegments(step), [step]);
  const firstName = (answers.name || view?.user.name || "").split(" ")[0] ?? "";

  // ---------- screens ----------
  let body: React.ReactNode = null;
  let wide = false;
  switch (step) {
    case "welcome":
      body = (
        <>
          <OnboardingOrb state={orb} size={340} />
          <h1 className="ob-title ob-title--hero">ORVYN is online.</h1>
          <p className="ob-sub">I'm ORION — the intelligence behind your ORVYN workspace. I can build, research, automate, deploy and work across your files, servers and tools.</p>
          <div className="ob-actions">
            <button className="ob-btn ob-btn--primary" onClick={() => { track("signup_started"); setStep(signedIn ? "provisioning" : "signup"); }} autoFocus>
              Let's get started {ICON.arrow}
            </button>
          </div>
          {!signedIn ? (
            <p className="ob-note">
              Already have an account?{" "}
              <button className="ob-link" data-testid="ob-welcome-signin" onClick={() => { setSigninFirst(true); setStep("signup"); }}>Sign in</button>
            </p>
          ) : null}
        </>
      );
      break;
    case "signup":
      body = <SignupScreen providers={providers} initialMode={signinFirst ? "login" : "register"} onSignedIn={async () => {
        const v = await refresh();
        const next = v?.profile.currentStep ?? "verification";
        setAnswers((a) => ({ ...a, ...(v?.profile.answers ?? {}) }));
        setCompleted(v?.profile.completedSteps ?? ["welcome", "signup"]);
        setStep(STEPS.indexOf(next) < STEPS.indexOf("verification") ? "verification" : next);
      }} />;
      break;
    case "verification":
      body = <VerificationScreen email={view?.user.email ?? ""} onVerified={() => setStep("provisioning")} onEmailChanged={() => void refresh()} />;
      break;
    case "provisioning":
      body = <ProvisioningScreen onReady={async () => {
        setOrb("success");
        const v = await refresh();
        window.setTimeout(() => {
          setOrb("idle");
          const next = v?.profile.currentStep && STEPS.indexOf(v.profile.currentStep) > STEPS.indexOf("provisioning") ? v.profile.currentStep : "name";
          setAnswers((a) => ({ ...a, ...(v?.profile.answers ?? {}) }));
          setStep(next);
        }, 900);
      }} onNeedsVerification={() => setStep("verification")} orb={orb} />;
      break;
    case "name":
      body = <NameScreen initial={answers.name || view?.user.name || ""} busy={busy} onContinue={(name) => void advance({ name })} />;
      break;
    case "primary_use":
      wide = true;
      body = (
        <MultiTiles
          title={<>What best describes<br />what you'll use ORVYN for?</>}
          sub="You can choose multiple options."
          options={PRIMARY_USE_OPTIONS.map((o) => ({ id: o.id, label: o.label, icon: ICON[o.icon] }))}
          initial={answers.primaryUse ?? []}
          busy={busy}
          onContinue={(ids) => void advance({ primaryUse: ids })}
        />
      );
      break;
    case "goals":
      body = <GoalsScreen initial={answers.goals ?? []} other={answers.goalOther ?? ""} busy={busy} onContinue={(goals, goalOther) => void advance({ goals, goalOther })} />;
      break;
    case "work_style":
      body = (
        <SingleList
          title="How should ORION work with you?"
          options={WORK_STYLE_OPTIONS.map((o) => ({ id: o.id, label: o.label, detail: o.detail, icon: ICON[o.icon] }))}
          initial={answers.workStyle ?? "adaptive"}
          busy={busy}
          onContinue={(id) => void advance({ workStyle: id as Answers["workStyle"] })}
        />
      );
      break;
    case "response_style":
      body = (
        <SingleList
          title="How should ORION communicate?"
          options={RESPONSE_STYLE_OPTIONS.map((o) => ({ id: o.id, label: o.label, detail: o.detail, icon: ICON[o.icon] }))}
          initial={answers.responseStyle ?? "adaptive"}
          busy={busy}
          onContinue={(id) => void advance({ responseStyle: id as Answers["responseStyle"] })}
        />
      );
      break;
    case "memory":
      body = (
        <SingleList
          title="Project Memory"
          sub={"ORVYN can remember useful project context, decisions and preferences so you don't have to explain the same work every time."}
          options={[
            { id: "on", label: "Enable Project Memory", detail: "Recommended", icon: ICON.memory },
            { id: "off", label: "Keep Memory Off", detail: "You can enable this later.", icon: ICON.memory },
          ]}
          initial={answers.memory === false ? "off" : "on"}
          busy={busy}
          onContinue={(id) => void advance({ memory: id === "on" })}
        />
      );
      break;
    case "workspace":
      body = <WorkspaceScreen initial={answers.workspace} busy={busy} onContinue={(ws) => void advance({ workspace: ws }, returnToRecap ? "recap" : ws.choice === "github" ? "github" : "github")} />;
      break;
    case "github":
      body = <GithubScreen available={providers.github} connected={Boolean(answers.githubConnected)} onLater={() => void advance()} onConnected={() => void advance({ githubConnected: true })} />;
      break;
    case "plan":
      wide = true;
      body = <PlanScreen plan={view?.plan ?? null} checkout={providers.checkout} busy={busy} onContinue={() => void advance()} />;
      break;
    case "recap":
      body = (
        <RecapScreen
          answers={answers}
          busy={busy}
          onEdit={(s) => { setReturnToRecap(true); setStep(s); }}
          onEnter={() => void advance({}, "first_mission")}
        />
      );
      break;
    case "first_mission":
      wide = true;
      body = (
        <FirstMissionScreen
          busy={busy}
          onPick={async (id) => {
            const m = FIRST_MISSIONS.find((x) => x.id === id);
            setBusy(true);
            await sync("complete", [...new Set([...completed, "first_mission" as Step])], { ...answers, firstMission: id ?? "empty" });
            setBusy(false);
            track(m ? "first_mission_started" : "onboarding_completed", m ? { mission: m.id } : {});
            onDone(m ? { mission: { prompt: m.prompt, mode: m.mode, projectRoot: answers.workspace?.path ?? null } } : {});
          }}
        />
      );
      break;
    case "complete":
      body = null;
      break;
  }

  const canBack = step !== "welcome" && step !== "signup" && step !== "verification" && step !== "provisioning" && step !== "name" && step !== "complete";
  return (
    <div className="ob-root" data-testid="onboarding" data-step={step}>
      <header className="ob-top">
        <div className="ob-brand" aria-label="ORVYN"><img className="ob-brand__mark" src={orvynMark} alt="" aria-hidden="true" /><span className="ob-wordmark">ORVYN</span></div>
        <div className="ob-top__right">
          {firstName && STEPS.indexOf(step) > STEPS.indexOf("name") ? <span>{firstName}</span> : null}
        </div>
      </header>
      <main className="ob-stage">
        <section key={step} className={`ob-panel${wide ? " ob-panel--wide" : ""}`} aria-live="polite">
          {error ? <div className="ob-banner" role="alert">{error}</div> : null}
          {body}
        </section>
      </main>
      {canBack ? <div className="ob-back"><button className="ob-link" onClick={back}>← Back</button></div> : null}
      <nav className="ob-progress" aria-label="Onboarding progress">
        {segments.map((s, i) => <i key={i} className={`is-${s}`} aria-current={s === "current" ? "step" : undefined} />)}
      </nav>
      {offline ? <div className="ob-offline" role="status">Offline — your choices are saved and will sync when ORVYN Cloud is reachable.</div> : null}
    </div>
  );
}

// ---------- screens ----------

function SignupScreen({ providers, onSignedIn, initialMode }: { providers: Providers; onSignedIn: () => Promise<void>; initialMode?: "register" | "login" }) {
  const [mode, setMode] = useState<"register" | "login">(initialMode ?? "register");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [touched, setTouched] = useState(false);
  const strength = passwordStrength(password);
  const emailBad = touched && !validEmail(email);
  const pwBad = touched && mode === "register" && !strength.ok;
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setTouched(true);
    if (!validEmail(email) || (mode === "register" && (!strength.ok || !name.trim())) || (mode === "login" && !password)) return;
    setBusy(true);
    setError("");
    const r = await signInWithCredentials({ backendUrl: accountBase(), email, password, name, mode });
    setBusy(false);
    if (!r.ok) { setError(r.error); return; }
    await onSignedIn();
  }
  const [browserWait, setBrowserWait] = useState<null | { provider: string; cancel: () => void }>(null);
  const [resetNote, setResetNote] = useState("");
  // Google/GitHub: sign in in the browser; this app then claims its session
  // with a secret only it holds. No session token ever travels in a URL.
  const social = (provider: "google" | "github") => {
    const enabled = providers[provider];
    return (
      <button type="button" className="ob-btn ob-btn--secondary ob-btn--block" disabled={!enabled || Boolean(browserWait)} title={enabled ? undefined : "Not switched on yet"}
        data-testid={`ob-oauth-${provider}`}
        onClick={() => { void browserSignIn(provider); }}>
        {provider === "google" ? ICON.google : ICON.github} Continue with {provider === "google" ? "Google" : "GitHub"}
      </button>
    );
  };
  async function browserSignIn(provider: "google" | "github") {
    setError("");
    const rand = (n: number) => { const b = new Uint8Array(n); crypto.getRandomValues(b); return b64url(b); };
    const hid = rand(24);
    const verifier = rand(32);
    const challenge = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
    const base = accountBase();
    let cancelled = false;
    setBrowserWait({ provider, cancel: () => { cancelled = true; setBrowserWait(null); } });
    void window.orvyn.window.openExternal?.(`${base}/api/v1/auth/oauth/${provider}/start?client=desktop&hid=${hid}&challenge=${challenge}`);
    const until = Date.now() + 10 * 60_000;
    while (!cancelled && Date.now() < until) {
      await new Promise((r) => setTimeout(r, 2000));
      if (cancelled) return;
      try {
        const r = await fetch(`${base}/api/v1/auth/handoff/claim`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ hid, verifier, device: navigator.userAgent }) });
        if (r.status === 202) continue;
        const d = await r.json().catch(() => ({}));
        if (r.ok && d.token) {
          await adoptBrowserSession(base, d);
          setBrowserWait(null);
          await onSignedIn();
          return;
        }
        setError(d.error || "Sign-in didn't finish. Try again.");
        break;
      } catch { /* offline for a moment: keep waiting */ }
    }
    if (!cancelled && Date.now() >= until) setError("Sign-in timed out. Try again.");
    setBrowserWait(null);
  }
  async function forgotPassword() {
    setTouched(true);
    if (!validEmail(email)) { setError("Enter your email above, then choose Forgot password."); return; }
    setError("");
    try {
      const r = await fetch(`${accountBase()}/api/v1/auth/password/forgot`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email }) });
      const d = await r.json().catch(() => ({}));
      setResetNote(d.message || "If an account uses that email, a reset link is on its way.");
    } catch {
      setError("Couldn't reach ORVYN. Try again in a moment.");
    }
  }
  return (
    <>
      <OnboardingOrb state="idle" size={150} />
      <h1 className="ob-title">{mode === "register" ? "Create your ORVYN account" : "Sign in to ORVYN"}</h1>
      <p className="ob-sub">One account. Access desktop, web and all your devices.</p>
      <div className="ob-social">
        {social("google")}
        {social("github")}
      </div>
      <div className="ob-or">OR</div>
      <form className="ob-form" onSubmit={submit} noValidate>
        {mode === "register" && (
          <div className={`ob-field${touched && !name.trim() ? " is-error" : ""}`}>
            <span className="ob-field__icon">{ICON.user}</span>
            <span className="ob-field__body"><label htmlFor="ob-name">Name</label><input id="ob-name" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name" /></span>
          </div>
        )}
        <div className={`ob-field${emailBad ? " is-error" : ""}`}>
          <span className="ob-field__icon">{ICON.mail}</span>
          <span className="ob-field__body"><label htmlFor="ob-email">Email</label><input id="ob-email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" aria-invalid={emailBad} /></span>
        </div>
        {emailBad ? <p className="ob-error">Enter a valid email address.</p> : null}
        <div className={`ob-field${pwBad ? " is-error" : ""}`}>
          <span className="ob-field__icon">{ICON.lock}</span>
          <span className="ob-field__body"><label htmlFor="ob-password">Password</label><input id="ob-password" type={show ? "text" : "password"} autoComplete={mode === "register" ? "new-password" : "current-password"} value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" aria-invalid={pwBad} /></span>
          <button type="button" className="ob-eye" onClick={() => setShow((v) => !v)} aria-label={show ? "Hide password" : "Show password"}>{show ? ICON.eyeOff : ICON.eye}</button>
        </div>
        {mode === "register" && password ? (
          <div className="ob-strength" aria-live="polite">
            <span className="ob-strength__bar">{[0, 1, 2, 3].map((i) => <i key={i} className={i < strength.score ? "on" : ""} />)}</span>
            <span>{strength.label}</span>
          </div>
        ) : null}
        {error ? <p className="ob-error" role="alert">{error}</p> : null}
        {resetNote ? <p className="ob-note" role="status" data-testid="ob-reset-note">{resetNote}</p> : null}
        {browserWait ? (
          <p className="ob-note" role="status" data-testid="ob-browser-wait">
            Finish signing in with {browserWait.provider === "google" ? "Google" : "GitHub"} in your browser — ORVYN continues on its own.{" "}
            <button type="button" className="ob-link" onClick={browserWait.cancel}>Cancel</button>
          </p>
        ) : null}
        <button type="submit" className="ob-btn ob-btn--primary ob-btn--block" disabled={busy || Boolean(browserWait)}>
          {busy ? "One moment…" : mode === "register" ? "Create Free Account" : "Sign In"}
        </button>
        {mode === "login" ? <button type="button" className="ob-link" data-testid="ob-forgot" onClick={() => void forgotPassword()}>Forgot password?</button> : null}
      </form>
      <p className="ob-note">
        {mode === "register" ? "Already have an account? " : "New to ORVYN? "}
        <button className="ob-link" onClick={() => { setMode(mode === "register" ? "login" : "register"); setError(""); setTouched(false); }}>
          {mode === "register" ? "Sign in" : "Create an account"}
        </button>
      </p>
    </>
  );
}

function VerificationScreen({ email, onVerified, onEmailChanged }: { email: string; onVerified: () => void; onEmailChanged: () => void }) {
  const [note, setNote] = useState("");
  const [changing, setChanging] = useState(false);
  const [newEmail, setNewEmail] = useState("");
  const [shown, setShown] = useState(email);
  useEffect(() => setShown(email), [email]);
  // The page notices verification on its own (the link opens in the browser).
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const r = await call<{ verified: boolean }>("/auth/verification/status");
        if (alive && r.ok && r.data.verified) onVerified();
      } catch { /* retry */ }
    };
    void tick();
    const t = window.setInterval(tick, 3000);
    return () => { alive = false; window.clearInterval(t); };
  }, [onVerified]);
  return (
    <>
      <div style={{ position: "relative" }}>
        <OnboardingOrb state="listening" size={240} />
        <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", color: "#fff", pointerEvents: "none" }}>
          <svg width="46" height="46" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true"><path d="M3 6h18v12H3zM3 7l9 6 9-6" /></svg>
        </div>
      </div>
      <h1 className="ob-title">Check your inbox</h1>
      <p className="ob-sub">We've sent a verification link to<br /><strong>{shown || "your email"}</strong></p>
      <ol className="ob-checklist" aria-label="What happens next">
        <li><span className="ob-tick ob-tick--num">1</span>Click the link in your email</li>
        <li><span className="ob-tick ob-tick--num">2</span>We'll set up your ORVYN workspace</li>
        <li><span className="ob-tick ob-tick--num">3</span>This window will update automatically</li>
      </ol>
      {changing ? (
        <form className="ob-form" style={{ marginTop: 18 }} onSubmit={async (e) => {
          e.preventDefault();
          if (!validEmail(newEmail)) { setNote("Enter a valid email address."); return; }
          const r = await call<{ email?: string; sent?: boolean; error?: string }>("/auth/verification/change-email", { method: "POST", body: { email: newEmail } });
          if (r.ok) { setShown(r.data.email ?? newEmail); setChanging(false); setNote(r.data.sent ? "New link sent." : r.data.error ?? ""); onEmailChanged(); }
          else setNote(r.data.error ?? "Could not change the email.");
        }}>
          <div className="ob-field"><span className="ob-field__icon">{ICON.mail}</span><span className="ob-field__body"><label htmlFor="ob-new-email">New email</label><input id="ob-new-email" type="email" value={newEmail} onChange={(e) => setNewEmail(e.target.value)} autoFocus /></span></div>
          <button className="ob-btn ob-btn--primary ob-btn--block" type="submit">Send new link</button>
        </form>
      ) : (
        <div className="ob-actions ob-actions--row">
          <button className="ob-link" onClick={async () => {
            const r = await call<{ sent?: boolean; error?: string; verified?: boolean }>("/auth/verification/resend", { method: "POST" });
            if (r.data.verified) onVerified();
            else setNote(r.data.sent ? "Sent. Check your inbox (and spam)." : r.data.error ?? "Could not send the email.");
          }}>Resend email</button>
          <button className="ob-link" onClick={() => { setChanging(true); setNote(""); }}>Change email</button>
        </div>
      )}
      {note ? <p className="ob-note" role="status">{note}</p> : null}
    </>
  );
}

function ProvisioningScreen({ onReady, onNeedsVerification, orb }: { onReady: () => void; onNeedsVerification: () => void; orb: OrbState }) {
  const [lines, setLines] = useState<ProvisionLine[]>([]);
  const [failed, setFailed] = useState(false);
  const fired = useRef(false);
  useEffect(() => {
    let alive = true;
    let tries = 0;
    const tick = async () => {
      tries++;
      try {
        const r = await call<ServerView>("/onboarding/provision", { method: "POST" });
        if (!alive) return;
        if (r.ok) {
          setLines(r.data.provisioning);
          setFailed(false);
          if (r.data.verificationRequired && !r.data.user.emailVerified) { onNeedsVerification(); return; }
          if (r.data.provisioning.every((l) => l.done) && !fired.current) { fired.current = true; onReady(); return; }
        }
      } catch {
        if (tries > 3) setFailed(true);
      }
      if (alive && !fired.current) window.setTimeout(tick, 1200);
    };
    void tick();
    return () => { alive = false; };
  }, [onReady, onNeedsVerification]);
  const shown = lines.length ? lines : [
    { id: "account", label: "Creating your account", done: false },
    { id: "workspace", label: "Setting up your workspace", done: false },
    { id: "plan", label: "Provisioning your Free plan", done: false },
    { id: "credits", label: "Adding your credits", done: false },
    { id: "orion", label: "Preparing ORION", done: false },
  ];
  // Lines appear done in order: a later line never shows a check before an earlier one.
  const firstPending = shown.findIndex((l) => !l.done);
  return (
    <>
      <OnboardingOrb state={orb === "success" ? "success" : "thinking"} size={260} />
      <h1 className="ob-title">Setting up your workspace...</h1>
      <p className="ob-sub">Creating your account and provisioning your ORVYN workspace. This only takes a few moments.</p>
      <ul className="ob-checklist" aria-label="Setup progress">
        {shown.map((l, i) => {
          const done = l.done && (firstPending < 0 || i < firstPending);
          return (
            <li key={l.id} className={done ? "" : "is-pending"} data-done={done}>
              {done ? <span className="ob-tick">{ICON.check}</span> : <span className="ob-spin" aria-hidden="true" />}
              <span>{l.label}{done && l.detail ? <span style={{ color: "var(--ob-text-2)" }}> · {l.detail}</span> : null}</span>
            </li>
          );
        })}
      </ul>
      {failed ? <p className="ob-note" role="status">Can't reach ORVYN Cloud right now — retrying…</p> : null}
    </>
  );
}

function NameScreen({ initial, busy, onContinue }: { initial: string; busy: boolean; onContinue: (name: string) => void }) {
  const [name, setName] = useState(initial);
  return (
    <>
      <OnboardingOrb state="speaking" size={160} />
      <h1 className="ob-title">What should I call you?</h1>
      <p className="ob-sub">This is how I'll address you.</p>
      <form onSubmit={(e) => { e.preventDefault(); if (name.trim()) onContinue(name.trim()); }} style={{ width: "100%", display: "grid", justifyItems: "center" }}>
        <label htmlFor="ob-callme" className="sr-only" style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)" }}>Your name</label>
        <input id="ob-callme" className="ob-input-solo" value={name} onChange={(e) => setName(e.target.value)} autoFocus maxLength={80} />
        <div className="ob-actions"><button className="ob-btn ob-btn--primary" type="submit" disabled={busy || !name.trim()}>Continue {ICON.arrow}</button></div>
      </form>
    </>
  );
}

function MultiTiles({ title, sub, options, initial, busy, onContinue }: { title: React.ReactNode; sub: string; options: { id: string; label: string; icon: React.ReactNode }[]; initial: string[]; busy: boolean; onContinue: (ids: any) => void }) {
  const [sel, setSel] = useState<string[]>(initial);
  const toggle = (id: string) => setSel((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  return (
    <>
      <OnboardingOrb state="idle" size={150} />
      <h1 className="ob-title">{title}</h1>
      <p className="ob-sub">{sub}</p>
      <div className="ob-grid" role="group" aria-label="Choose all that apply">
        {options.map((o) => (
          <button key={o.id} className={`ob-card ob-card--tile${sel.includes(o.id) ? " is-selected" : ""}`} aria-pressed={sel.includes(o.id)} onClick={() => toggle(o.id)}>
            <Check on={sel.includes(o.id)} />
            <span className="ob-card__icon">{o.icon}</span>
            <span className="ob-card__title">{o.label}</span>
          </button>
        ))}
      </div>
      <div className="ob-actions"><button className="ob-btn ob-btn--primary" disabled={busy || sel.length === 0} onClick={() => onContinue(sel)}>Continue {ICON.arrow}</button></div>
    </>
  );
}

function GoalsScreen({ initial, other, busy, onContinue }: { initial: string[]; other: string; busy: boolean; onContinue: (goals: any, other: string) => void }) {
  const [sel, setSel] = useState<string[]>(initial);
  const [text, setText] = useState(other);
  const toggle = (id: string) => setSel((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  return (
    <>
      <OnboardingOrb state="idle" size={150} />
      <h1 className="ob-title">What do you want ORVYN<br />to help you accomplish?</h1>
      <p className="ob-sub">Select a few goals or tell me your own.</p>
      <div className="ob-list" role="group" aria-label="Goals">
        {GOAL_OPTIONS.map((o) => (
          <div key={o.id} className={`ob-checkrow${sel.includes(o.id) ? " is-selected" : ""}`} role="checkbox" aria-checked={sel.includes(o.id)} tabIndex={0}
            onClick={() => toggle(o.id)} onKeyDown={(e) => { if (e.key === " " || e.key === "Enter") { e.preventDefault(); toggle(o.id); } }}>
            <Check on={sel.includes(o.id)} />
            {o.id === "other" && sel.includes("other")
              ? <input aria-label="Your goal" value={text} onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()} onChange={(e) => setText(e.target.value)} placeholder="Tell me…" autoFocus />
              : <span>{o.label}</span>}
          </div>
        ))}
      </div>
      <div className="ob-actions"><button className="ob-btn ob-btn--primary" disabled={busy || sel.length === 0 || (sel.includes("other") && !text.trim() && sel.length === 1)} onClick={() => onContinue(sel, sel.includes("other") ? text : "")}>Continue {ICON.arrow}</button></div>
    </>
  );
}

function SingleList({ title, sub, options, initial, busy, onContinue }: { title: string; sub?: string; options: { id: string; label: string; detail: string; icon: React.ReactNode }[]; initial: string; busy: boolean; onContinue: (id: string) => void }) {
  const [sel, setSel] = useState(initial);
  return (
    <>
      <OnboardingOrb state="idle" size={150} />
      <h1 className="ob-title">{title}</h1>
      {sub ? <p className="ob-sub">{sub}</p> : <div style={{ height: 14 }} />}
      <div className="ob-list" role="radiogroup" aria-label={title}>
        {options.map((o) => (
          <button key={o.id} role="radio" aria-checked={sel === o.id} className={`ob-card${sel === o.id ? " is-selected" : ""}`} onClick={() => setSel(o.id)}>
            <span className="ob-card__icon">{o.icon}</span>
            <span className="ob-card__text"><span className="ob-card__title">{o.label}</span><span className="ob-card__detail">{o.detail}</span></span>
            <Check on={sel === o.id} />
          </button>
        ))}
      </div>
      <div className="ob-actions"><button className="ob-btn ob-btn--primary" disabled={busy} onClick={() => onContinue(sel)}>Continue {ICON.arrow}</button></div>
    </>
  );
}

function WorkspaceScreen({ initial, busy, onContinue }: { initial?: Answers["workspace"]; busy: boolean; onContinue: (ws: NonNullable<Answers["workspace"]>) => void }) {
  const [choice, setChoice] = useState<NonNullable<Answers["workspace"]>["choice"]>(initial?.choice ?? "new_project");
  const [projectName, setProjectName] = useState(initial?.projectName ?? "My ORVYN project");
  const [repoUrl, setRepoUrl] = useState(initial?.repoUrl ?? "");
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const [picked, setPicked] = useState<string | undefined>(initial?.path);
  async function go() {
    setError("");
    if (choice === "none" || choice === "github") { onContinue({ choice }); return; }
    setWorking(true);
    try {
      if (choice === "new_project") {
        const ws = await window.orvyn.project.create(projectName);
        if (!ws) return;
        setPicked(ws.root);
        onContinue({ choice, path: ws.root, projectName });
      } else if (choice === "local_folder") {
        const ws = await window.orvyn.project.open();
        if (!ws) return;
        setPicked(ws.root);
        onContinue({ choice, path: ws.root });
      } else if (choice === "clone_repo") {
        const out = await window.orvyn.project.clone(repoUrl);
        if (!out) return;
        if ("error" in out) { setError(out.error); return; }
        setPicked(out.root);
        onContinue({ choice, path: out.root, repoUrl });
      }
    } catch (err: any) {
      setError(err?.message ?? "That did not work. Try again.");
    } finally {
      setWorking(false);
    }
  }
  return (
    <>
      <OnboardingOrb state="idle" size={150} />
      <h1 className="ob-title">Where should we start?</h1>
      <div style={{ height: 14 }} />
      <div className="ob-list" role="radiogroup" aria-label="Where should we start?">
        {WORKSPACE_OPTIONS.map((o) => (
          <button key={o.id} role="radio" aria-checked={choice === o.id} className={`ob-card${choice === o.id ? " is-selected" : ""}`} onClick={() => setChoice(o.id)}>
            <span className="ob-card__icon">{ICON[WORKSPACE_ICON[o.id]!]}</span>
            <span className="ob-card__text"><span className="ob-card__title">{o.label}</span></span>
            <Check on={choice === o.id} />
          </button>
        ))}
      </div>
      {choice === "new_project" ? <input className="ob-input-solo" style={{ marginTop: 12, fontSize: 14 }} aria-label="Project name" value={projectName} onChange={(e) => setProjectName(e.target.value)} /> : null}
      {choice === "clone_repo" ? <input className="ob-input-solo" style={{ marginTop: 12, fontSize: 14 }} aria-label="Repository address" placeholder="https://github.com/you/repo.git" value={repoUrl} onChange={(e) => setRepoUrl(e.target.value)} /> : null}
      {picked ? <p className="ob-note">Current: {picked}</p> : null}
      {error ? <p className="ob-error" role="alert">{error}</p> : null}
      <div className="ob-actions">
        <button className="ob-btn ob-btn--primary" disabled={busy || working || (choice === "clone_repo" && !repoUrl.trim())} onClick={() => void go()}>
          {working ? (choice === "clone_repo" ? "Cloning…" : "Opening…") : <>Continue {ICON.arrow}</>}
        </button>
      </div>
    </>
  );
}

function GithubScreen({ available, connected, onLater, onConnected }: { available: boolean; connected: boolean; onLater: () => void; onConnected: () => void }) {
  const [waiting, setWaiting] = useState(false);
  useEffect(() => {
    if (!waiting) return;
    const t = window.setInterval(async () => {
      const r = await call<{ connected?: boolean }>("/onboarding/github").catch(() => null);
      if (r?.ok && r.data.connected) { window.clearInterval(t); onConnected(); }
    }, 2500);
    return () => window.clearInterval(t);
  }, [waiting, onConnected]);
  return (
    <>
      <div style={{ position: "relative" }}>
        <OnboardingOrb state={waiting ? "connecting" : "idle"} size={200} />
        <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", color: "#fff", pointerEvents: "none" }}>
          <svg width="44" height="44" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 .5a12 12 0 0 0-3.8 23.4c.6.1.8-.3.8-.6v-2.2c-3.3.7-4-1.6-4-1.6-.6-1.4-1.4-1.8-1.4-1.8-1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1 1.8 2.8 1.3 3.5 1 .1-.8.4-1.3.7-1.6-2.7-.3-5.5-1.3-5.5-6 0-1.3.5-2.4 1.2-3.2-.1-.3-.5-1.5.1-3.2 0 0 1-.3 3.3 1.2a11.5 11.5 0 0 1 6 0C17.3 4.7 18.3 5 18.3 5c.7 1.7.3 2.9.1 3.2.8.8 1.2 1.9 1.2 3.2 0 4.6-2.8 5.6-5.5 5.9.4.4.8 1.1.8 2.2v3.3c0 .3.2.7.8.6A12 12 0 0 0 12 .5z" /></svg>
        </div>
      </div>
      <h1 className="ob-title">Connect GitHub</h1>
      <p className="ob-sub">Access your repositories to work on projects.</p>
      <ul className="ob-checklist">
        <li><span className="ob-tick">{ICON.check}</span>Secure OAuth connection</li>
        <li><span className="ob-tick">{ICON.check}</span>No passwords stored</li>
        <li><span className="ob-tick">{ICON.check}</span>You control access</li>
      </ul>
      <div className="ob-actions">
        {connected ? (
          <button className="ob-btn ob-btn--primary" onClick={onLater}>Connected — Continue {ICON.arrow}</button>
        ) : (
          <button className="ob-btn ob-btn--primary" data-testid="ob-github-connect" disabled={!available || waiting} onClick={async () => {
            // A one-time link from this signed-in app; the browser never carries the session.
            const r = await call<{ url?: string; error?: string }>("/auth/github/connect-link", { method: "POST", body: {} }).catch(() => null);
            if (!r?.ok || !r.data.url) return;
            setWaiting(true);
            void window.orvyn.window.openExternal?.(r.data.url);
          }}>{waiting ? "Waiting for GitHub…" : "Connect GitHub"}</button>
        )}
        {!available ? <p className="ob-note">GitHub connection isn't switched on for this server yet. You can connect it later from Settings.</p> : null}
        <button className="ob-link" onClick={onLater}>Do this later</button>
      </div>
    </>
  );
}

function PlanScreen({ plan, checkout, busy, onContinue }: { plan: PlanView | null; checkout: boolean; busy: boolean; onContinue: () => void }) {
  const [showPlans, setShowPlans] = useState(false);
  useEffect(() => { if (showPlans) track("upgrade_viewed", { from: "onboarding" }); }, [showPlans]);
  if (showPlans) return <PlansPanel currentId={plan?.id ?? "free"} checkout={checkout} onBack={() => setShowPlans(false)} />;
  const p = plan;
  const fmt = (n: number) => n.toLocaleString("en-US");
  const items = p ? [
    `${fmt(p.monthlyCredits)} monthly credits`,
    `${fmt(p.rolling5h)} credits per 5 hours (rolling)`,
    p.projects ? `${p.projects} project${p.projects === 1 ? "" : "s"}` : "Unlimited projects",
    "AUTO model routing",
    p.features.premiumModels === "none" ? "Basic agent access" : "Premium agent access",
  ] : [];
  return (
    <>
      <OnboardingOrb state="idle" size={160} />
      <h1 className="ob-title">You're starting with ORVYN {p?.label ?? "Free"}.</h1>
      {p ? (
        <ul className="ob-checklist" style={{ margin: "14px 0 4px" }}>
          {items.map((t) => <li key={t}><span className="ob-tick">{ICON.check}</span>{t}</li>)}
        </ul>
      ) : <p className="ob-sub">Loading your plan…</p>}
      <div className="ob-actions ob-actions--row">
        <button className="ob-btn ob-btn--primary" disabled={busy} onClick={onContinue}>Continue {p?.label ?? "Free"} {ICON.arrow}</button>
        <button className="ob-btn ob-btn--secondary" onClick={() => setShowPlans(true)}>View Plans</button>
      </div>
    </>
  );
}

export function PlansPanel({ currentId, checkout, onBack }: { currentId: string; checkout: boolean; onBack?: () => void }) {
  const [plans, setPlans] = useState<PlanView[]>([]);
  const [yearly, setYearly] = useState(false);
  const [note, setNote] = useState("");
  useEffect(() => { void call<{ plans: PlanView[] }>("/onboarding/plans").then((r) => r.ok && setPlans(r.data.plans)).catch(() => undefined); }, []);
  return (
    <>
      <h1 className="ob-title">Choose your plan</h1>
      <div className="ob-toggle" role="group" aria-label="Billing period">
        <button className={!yearly ? "is-on" : ""} onClick={() => setYearly(false)} aria-pressed={!yearly}>Monthly</button>
        <button className={yearly ? "is-on" : ""} onClick={() => setYearly(true)} aria-pressed={yearly}>Yearly <span className="ob-save">Save 20%</span></button>
      </div>
      <div className="ob-plans">
        {plans.map((p) => {
          const price = yearly ? p.priceAnnualUsd : p.priceMonthlyUsd;
          const current = p.id === currentId;
          return (
            <div key={p.id} className={`ob-plan${current ? " is-current" : ""}`}>
              <span className="ob-plan__name">{p.label}</span>
              <span>
                <span className="ob-plan__price">{price == null ? "—" : `$${price.toLocaleString("en-US")}`}<small>{price == null ? "" : yearly ? "/year" : "/month"}</small></span>
                <span className="ob-plan__credits" style={{ display: "block" }}>{p.monthlyCredits.toLocaleString("en-US")} credits / month</span>
              </span>
              {current
                ? <button className="ob-btn ob-btn--secondary" disabled>Current Plan</button>
                : <button className="ob-btn ob-btn--primary" disabled={!checkout} title={checkout ? undefined : "Checkout isn't switched on yet"} onClick={async () => {
                    track("checkout_started", { plan: p.id, period: yearly ? "yearly" : "monthly" });
                    const r = await call<{ url?: string; error?: string }>("/billing/checkout", { method: "POST", body: { planId: p.id, period: yearly ? "yearly" : "monthly" } }).catch(() => null);
                    if (r?.ok && r.data.url) void window.orvyn.window.openExternal?.(r.data.url);
                    else setNote(r?.data?.error ?? "Checkout isn't available yet.");
                  }}>Upgrade</button>}
            </div>
          );
        })}
      </div>
      {!checkout ? <p className="ob-note">Upgrades open secure web checkout once billing is switched on.</p> : null}
      {note ? <p className="ob-note" role="status">{note}</p> : null}
      {onBack ? <div className="ob-actions"><button className="ob-link" onClick={onBack}>← Back to your plan</button></div> : null}
    </>
  );
}

function RecapScreen({ answers, busy, onEdit, onEnter }: { answers: Answers; busy: boolean; onEdit: (s: Step) => void; onEnter: () => void }) {
  const rows = recapRows(answers);
  return (
    <>
      <OnboardingOrb state="success" size={140} />
      <h1 className="ob-title">Ready to go.</h1>
      <p className="ob-sub">Here's your ORVYN setup.</p>
      <div className="ob-recap" role="table" aria-label="Your setup">
        {rows.map((r) => (
          <div key={r.key} className="ob-recap__row" role="row">
            <span className="ob-recap__icon" aria-hidden="true">{ICON[RECAP_ICON[r.key]!]}</span>
            <span className="ob-recap__label" role="rowheader">{r.label}</span>
            <span className="ob-recap__value" role="cell" title={r.value}>{r.value}</span>
            <button className="ob-link" style={{ fontSize: 12.5 }} onClick={() => onEdit(r.step)} aria-label={`Edit ${r.label}`}>Edit</button>
          </div>
        ))}
      </div>
      <div className="ob-actions"><button className="ob-btn ob-btn--primary" disabled={busy} onClick={onEnter}>Enter ORVYN {ICON.arrow}</button></div>
    </>
  );
}

function FirstMissionScreen({ busy, onPick }: { busy: boolean; onPick: (id: string | null) => void }) {
  return (
    <>
      <OnboardingOrb state="idle" size={150} />
      <h1 className="ob-title">What should we do first?</h1>
      <p className="ob-sub">Here are a few ideas to get started.</p>
      <div className="ob-missions">
        {FIRST_MISSIONS.map((m) => (
          <button key={m.id} className="ob-card ob-mission" disabled={busy} onClick={() => onPick(m.id)}>
            <span className="ob-card__title">{m.label}</span>
            <span className="ob-card__detail">{m.detail}</span>
          </button>
        ))}
      </div>
      <div className="ob-actions"><button className="ob-btn ob-btn--secondary" disabled={busy} onClick={() => onPick(null)}>Start with an empty workspace</button></div>
    </>
  );
}
