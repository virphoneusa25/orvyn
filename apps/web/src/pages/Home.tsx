import { useRef, useState } from "react";
import { useStore } from "../lib/store";
import { navigate } from "../lib/router";
import { ago, firstName, num } from "../lib/format";
import { signal, useSignal } from "../lib/events";
import { useApi, type Artifact, type Project, type SessionRow } from "../lib/useApi";
import { dailyPoints, type Stats } from "../lib/usage";
import { uploadFiles } from "../lib/upload";
import { Orb } from "../components/Orb";
import { Icon } from "../components/Icons";
import { Bar, hueFor } from "../components/Bits";
import { FileRow } from "../components/FileRow";
import { UsageChart } from "../components/UsageChart";

export interface Invoice { id: string; date: number; description: string; amountUsd: number; status: string; hostedUrl: string | null; pdfUrl: string | null }
export interface Account { invoices: Invoice[]; paymentMethod: { brand: string; last4: string; expMonth: number; expYear: number } | null; subscription: { cancelAtPeriodEnd: boolean; currentPeriodEnd: number | null; status: string } | null }

const HOME_STARTERS = ["Summarize a document", "Write an email", "Explain some code", "Brainstorm ideas"];

function greeting(): string {
  const h = new Date().getHours();
  return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

function resetIn(ts: number): string {
  const ms = Math.max(0, ts - Date.now());
  const h = Math.floor(ms / 3_600_000), m = Math.floor((ms % 3_600_000) / 60_000);
  return h >= 48 ? `${Math.round(h / 24)} days` : h ? `${h}h ${m}m` : `${m}m`;
}

export function Home() {
  const { me, billing, toast } = useStore();
  const sessions = useApi<{ sessions: SessionRow[] }>("/sessions");
  const projects = useApi<{ projects: Project[] }>("/projects");
  const files = useApi<{ artifacts: Artifact[] }>("/artifacts");
  const stats = useApi<Stats>("/billing/stats");
  const [range, setRange] = useState<7 | 30>(7);
  const [ask, setAsk] = useState("");
  const upload = useRef<HTMLInputElement | null>(null);
  useSignal("sessions", sessions.reload);
  useSignal("files", files.reload);

  const recentChats = [...(sessions.data?.sessions ?? [])].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 5);
  const recentProjects = (projects.data?.projects ?? []).slice(0, 4);
  const recentFiles = [...(files.data?.artifacts ?? [])].filter((a) => a.kind !== "run").sort((a, b) => b.createdAt - a.createdAt).slice(0, 4);
  const w = billing?.wallet;
  const go = (text: string) => { const t = text.trim(); if (t) navigate(`/chats?q=${encodeURIComponent(t)}`); };

  const actions: { label: string; sub: string; icon: React.ReactNode; run: () => void }[] = [
    { label: "New chat", sub: "Start a conversation", icon: <Icon.chat />, run: () => navigate("/chats") },
    { label: "New project", sub: "Group chats and files", icon: <Icon.folder />, run: () => navigate("/projects?new=1") },
    { label: "Upload files", sub: "Add to your library", icon: <Icon.upload />, run: () => upload.current?.click() },
    { label: w && w.plan.id !== "free" ? "Manage plan" : "Upgrade plan", sub: "Plan, credits and invoices", icon: <Icon.crown />, run: () => navigate("/billing") },
  ];

  return (
    <div className="home">
      <input ref={upload} type="file" multiple hidden data-testid="home-upload" onChange={async (e) => {
        const list = Array.from(e.target.files ?? []);
        e.target.value = "";
        if (!list.length) return;
        const r = await uploadFiles(list);
        toast(r.skipped.length ? `Uploaded ${r.ok}. Skipped: ${r.skipped.join(", ")}` : `Uploaded ${r.ok} file${r.ok === 1 ? "" : "s"}.`);
        files.reload(); signal("files");
      }} />

      <section className="home-hero" aria-label="Welcome">
        <div className="home-hero__orb"><Orb /></div>
        <p className="home-hero__hello" data-testid="hero-hello">Welcome back, {firstName(me?.user.name, me?.user.email)}</p>
        <h1>{greeting()}. <span className="g">What can I help with?</span></h1>
        <form className="composer home-ask" onSubmit={(e) => { e.preventDefault(); go(ask); }} data-testid="home-ask">
          <textarea rows={2} value={ask} onChange={(e) => setAsk(e.target.value)} placeholder="Ask ORVYN anything…" aria-label="Ask ORVYN"
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); go(ask); } }} />
          <div className="composer__row">
            <span className="faint" style={{ fontSize: 12 }}>Opens a new chat · Enter to send</span>
            <button type="submit" className="composer__send" aria-label="Start chat" disabled={!ask.trim()}><Icon.arrowUp size={18} /></button>
          </div>
        </form>
        <div className="home-starters">
          {HOME_STARTERS.map((s) => <button key={s} className="chip" onClick={() => go(s)}><Icon.spark size={14} /> {s}</button>)}
        </div>
      </section>

      <div className="home-meters" data-testid="home-meters">
        <button className="card card--hover meter" onClick={() => navigate("/billing#plans")}>
          <span className="meter__label"><Icon.crown size={15} /> Current plan</span>
          <span className="meter__value" data-testid="stat-plan">{w?.plan.label ?? "…"}</span>
          <span className="meter__foot">{w && w.plan.id !== "free" ? w.plan.priceLabel : "Upgrade anytime"}</span>
        </button>
        <button className="card card--hover meter" onClick={() => navigate("/billing#credits")}>
          <span className="meter__label"><Icon.coins size={15} /> Credits available</span>
          <span className="meter__value">{num(w?.availableBalance)}</span>
          <span className="meter__foot">{num(w?.windows.cycle.used)} of {num(w?.windows.cycle.limit)} monthly used · <span data-testid="stat-topup">{num(w?.purchasedBalance)} top-up</span></span>
        </button>
        <div className="card meter">
          <span className="meter__label"><Icon.clock size={15} /> 5-hour window</span>
          <span className="meter__value">{num(w?.windows.fiveHour.used)} <small>/ {num(w?.windows.fiveHour.limit)}</small></span>
          {w ? <Bar used={w.windows.fiveHour.used} limit={w.windows.fiveHour.limit} hidePct /> : null}
          <span className="meter__foot">{w ? `Frees up in ${resetIn(w.windows.fiveHour.resetAt)}` : ""}</span>
        </div>
        <div className="card meter">
          <span className="meter__label"><Icon.bars size={15} /> 7-day window</span>
          <span className="meter__value">{num(w?.windows.sevenDay.used)} <small>/ {num(w?.windows.sevenDay.limit)}</small></span>
          {w ? <Bar used={w.windows.sevenDay.used} limit={w.windows.sevenDay.limit} hidePct /> : null}
          <span className="meter__foot">{w ? `Frees up in ${resetIn(w.windows.sevenDay.resetAt)}` : ""}</span>
        </div>
      </div>

      <div className="home-quick">
        {actions.map((a) => (
          <button key={a.label} className="qa__btn" onClick={a.run}>
            <span className="qa__icon">{a.icon}</span>
            <span><b>{a.label}</b><span>{a.sub}</span></span>
            <span className="qa__chev"><Icon.chev size={15} /></span>
          </button>
        ))}
      </div>

      <div className="home-cols">
        <section className="card card--pad" aria-label="Recent chats">
          <div className="card__head"><h3>Continue where you left off</h3><a className="link" href="/chats" onClick={(e) => { e.preventDefault(); navigate("/chats"); }}>All chats</a></div>
          <div className="list">
            {recentChats.map((s) => (
              <button key={s.sessionId} className="list__row" onClick={() => navigate(s.projectId && !s.projectRoot ? `/projects/${s.projectId}/chats/${s.sessionId}` : `/chats/${s.sessionId}`)}>
                <span className="qa__icon" style={{ width: 32, height: 32 }}>{s.projectRoot ? <Icon.monitor size={16} /> : <Icon.chat size={16} />}</span>
                <span className="list__main"><b>{s.title || "Conversation"}</b><span className="sub">{(s.lastMessage ?? "").slice(0, 90) || (s.projectRoot ? "ORVYN Desktop" : "Cloud chat")}</span></span>
                <span className="faint" style={{ fontSize: 12, whiteSpace: "nowrap" }}>{ago(s.updatedAt)}</span>
              </button>
            ))}
            {sessions.data && !recentChats.length ? <div className="list__empty">No chats yet — ask ORVYN something above.</div> : null}
          </div>
        </section>
        <div className="grid" style={{ alignContent: "start" }}>
          <section className="card card--pad" aria-label="Recent projects">
            <div className="card__head"><h3>Projects</h3><a className="link" href="/projects" onClick={(e) => { e.preventDefault(); navigate("/projects"); }}>View all</a></div>
            <div className="list">
              {recentProjects.map((p) => (
                <button key={p.id} className="list__row" onClick={() => navigate(`/projects/${p.id}`)}>
                  <span className="project-card__icon" style={{ width: 30, height: 30, borderRadius: 9, fontSize: 13, background: hueFor(p.name) }}>{p.name.slice(0, 1).toUpperCase()}</span>
                  <span className="list__main"><b>{p.name}</b><span className="sub">{p.description?.slice(0, 60) || `Updated ${ago(p.updatedAt ?? p.createdAt)}`}</span></span>
                </button>
              ))}
              {projects.data && !recentProjects.length ? <div className="list__empty">No projects yet. <a href="/projects?new=1" onClick={(e) => { e.preventDefault(); navigate("/projects?new=1"); }}>Create one</a></div> : null}
            </div>
          </section>
          <section className="card card--pad" aria-label="Recent files">
            <div className="card__head"><h3>Recent files</h3><a className="link" href="/files" onClick={(e) => { e.preventDefault(); navigate("/files"); }}>View all</a></div>
            <div className="list">
              {recentFiles.map((a) => <FileRow key={a.artifactId} a={a} />)}
              {files.data && !recentFiles.length ? <div className="list__empty">No files yet.</div> : null}
            </div>
          </section>
        </div>
      </div>

      <section className="card card--pad" style={{ marginTop: 16 }} aria-label="Usage overview">
        <div className="card__head"><h3>Usage</h3><span className="muted">credits per day</span>
          <div className="seg" role="tablist" aria-label="Period" style={{ marginLeft: "auto" }}><button className={range === 7 ? "is-on" : ""} onClick={() => setRange(7)}>7 days</button><button className={range === 30 ? "is-on" : ""} onClick={() => setRange(30)}>30 days</button></div>
        </div>
        <UsageChart points={dailyPoints(stats.data, range)} height={170} />
      </section>
    </div>
  );
}
