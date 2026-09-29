import { useRef, useState } from "react";
import { useStore } from "../lib/store";
import { navigate } from "../lib/router";
import { ago, date, firstName, money } from "../lib/format";
import { useApi, type Artifact, type Project, type SessionRow } from "../lib/useApi";
import { dailyPoints, type Stats } from "../lib/usage";
import { uploadFiles } from "../lib/upload";
import { Orb } from "../components/Orb";
import { Icon, FolderGlyph } from "../components/Icons";
import { StatCards } from "../components/Stats";
import { ChatThread } from "../components/ChatThread";
import { FileRow } from "../components/FileRow";
import { UsageChart } from "../components/UsageChart";

export interface Invoice { id: string; date: number; description: string; amountUsd: number; status: string; hostedUrl: string | null; pdfUrl: string | null }
export interface Account { invoices: Invoice[]; paymentMethod: { brand: string; last4: string; expMonth: number; expYear: number } | null; subscription: { cancelAtPeriodEnd: boolean; currentPeriodEnd: number | null; status: string } | null }

function greeting(): string {
  const h = new Date().getHours();
  return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

export function Home() {
  const { me, billing, toast } = useStore();
  const [chatId, setChatId] = useState<string | null>(null);
  const sessions = useApi<{ sessions: SessionRow[] }>("/sessions");
  const projects = useApi<{ projects: Project[] }>("/projects");
  const files = useApi<{ artifacts: Artifact[] }>("/artifacts");
  const stats = useApi<Stats>("/billing/stats");
  const account = useApi<Account>("/billing/account");
  const upload = useRef<HTMLInputElement | null>(null);

  const recentChats = [...(sessions.data?.sessions ?? [])].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 4);
  const recentProjects = (projects.data?.projects ?? []).slice(0, 4);
  const recentFiles = [...(files.data?.artifacts ?? [])].sort((a, b) => b.createdAt - a.createdAt).slice(0, 4);
  const invoices = (account.data?.invoices ?? []).slice(0, 4);

  const actions: { label: string; sub: string; icon: React.ReactNode; go: () => void; plus?: boolean }[] = [
    { label: "New Chat", sub: "Start a new conversation", icon: <Icon.chat />, go: () => navigate("/chats") },
    { label: "New Project", sub: "Organize chats and files", icon: <Icon.folder />, go: () => navigate("/projects?new=1") },
    { label: "Upload Files", sub: "Add files to your account", icon: <Icon.upload />, go: () => upload.current?.click() },
    { label: "Buy Credits", sub: "Top up your balance", icon: <Icon.plus />, go: () => navigate("/billing#credits"), plus: true },
  ];

  return (
    <>
      <input ref={upload} type="file" multiple hidden data-testid="home-upload" onChange={async (e) => {
        const list = Array.from(e.target.files ?? []);
        e.target.value = "";
        if (!list.length) return;
        const r = await uploadFiles(list);
        toast(r.skipped.length ? `Uploaded ${r.ok}. Skipped: ${r.skipped.join(", ")}` : `Uploaded ${r.ok} file${r.ok === 1 ? "" : "s"}.`);
        files.reload();
      }} />
      <div className="home-top">
        <section className="hero" aria-label="Welcome">
          <div className="hero__stars" />
          <div className="hero__orb"><Orb /></div>
          <p className="hero__hello">{greeting()}, {firstName(me?.user.name, me?.user.email)}</p>
          <h1><span className="g1">Welcome to</span><br /><span className="g2">ORVYN Cloud</span></h1>
          <p>Chat with ORVYN, keep your projects and files in one place, and pick up anywhere — here or in ORVYN Desktop.</p>
          <div className="hero__script">Ideas to what's next</div>
        </section>
        <section className="card qa" aria-label="Quick actions">
          <h3>Quick Actions</h3>
          <div className="muted">Get started with ORVYN</div>
          <div className="qa__grid">
            {actions.map((a) => (
              <button key={a.label} className="qa__btn" onClick={a.go}>
                <span className={`qa__icon${a.plus ? " qa__icon--plus" : ""}`}>{a.icon}</span>
                <span><b>{a.label}</b><span>{a.sub}</span></span>
                <span className="qa__chev"><Icon.chev size={16} /></span>
              </button>
            ))}
          </div>
        </section>
      </div>

      {billing ? <StatCards w={billing.wallet} /> : <div className="stats"><div className="card stat">Loading your account…</div></div>}

      <div className="home-bottom">
        <section className="card card--pad home-chat" aria-label="Cloud chat">
          <div className="card__head">
            <Icon.chat size={24} /><h3>Cloud Chat</h3>
            {chatId ? <a className="link" href={`/chats/${chatId}`} onClick={(e) => { e.preventDefault(); navigate(`/chats/${chatId}`); }}>Open in Chats</a> : null}
          </div>
          <ChatThread sessionId={chatId} onSession={(id) => { setChatId(id); window.setTimeout(sessions.reload, 400); }} compact
            placeholder="Ask ORVYN anything…" suggestions={["Summarize a document", "Write an email", "Explain some code"]} />
        </section>

        <div>
          <div className="home-lists">
            <section className="card card--pad" aria-label="Recent projects">
              <div className="card__head"><h3>Recent Projects</h3><a className="link" href="/projects" onClick={(e) => { e.preventDefault(); navigate("/projects"); }}>View all</a></div>
              <div className="list">
                {recentProjects.map((p, i) => (
                  <button key={p.id} className="list__row" onClick={() => navigate(`/projects/${p.id}`)}>
                    <FolderGlyph hue={i} />
                    <span className="list__main"><b>{p.name}</b><span className="sub">Created {ago(p.createdAt)}</span></span>
                  </button>
                ))}
                {!recentProjects.length ? <div className="list__empty">No projects yet. <a href="/projects?new=1" onClick={(e) => { e.preventDefault(); navigate("/projects?new=1"); }}>Create one</a></div> : null}
              </div>
            </section>
            <section className="card card--pad" aria-label="Recent chats">
              <div className="card__head"><h3>Recent Chats</h3><a className="link" href="/chats" onClick={(e) => { e.preventDefault(); navigate("/chats"); }}>View all</a></div>
              <div className="list">
                {recentChats.map((s) => (
                  <button key={s.sessionId} className="list__row" onClick={() => navigate(`/chats/${s.sessionId}`)}>
                    <Icon.chat size={22} />
                    <span className="list__main"><b>{s.title || "Conversation"}</b><span className="sub">{ago(s.updatedAt)}</span></span>
                  </button>
                ))}
                {!recentChats.length ? <div className="list__empty">No chats yet.</div> : null}
              </div>
            </section>
            <section className="card card--pad" aria-label="Recent files">
              <div className="card__head"><h3>Recent Files</h3><a className="link" href="/files" onClick={(e) => { e.preventDefault(); navigate("/files"); }}>View all</a></div>
              <div className="list">
                {recentFiles.map((a) => <FileRow key={a.artifactId} a={a} />)}
                {!recentFiles.length ? <div className="list__empty">No files yet.</div> : null}
              </div>
            </section>
          </div>
          <div className="home-lists2">
            <section className="card card--pad" aria-label="Usage overview">
              <div className="card__head"><h3>Usage Overview</h3><span className="muted">Last 7 days · credits</span><a className="link" href="/usage" onClick={(e) => { e.preventDefault(); navigate("/usage"); }}>Details</a></div>
              <UsageChart points={dailyPoints(stats.data, 7)} />
            </section>
            <section className="card card--pad" aria-label="Invoices">
              <div className="card__head"><h3>Invoices</h3><a className="link" href="/billing" onClick={(e) => { e.preventDefault(); navigate("/billing#invoices"); }}>View all</a></div>
              {invoices.length ? (
                <table className="table">
                  <thead><tr><th>Date</th><th>Description</th><th>Amount</th><th>Status</th></tr></thead>
                  <tbody>{invoices.map((inv) => (
                    <tr key={inv.id}><td>{date(inv.date)}</td><td>{inv.description}</td><td>{money(inv.amountUsd)}</td><td><span className={`tag ${inv.status === "paid" ? "tag--paid" : "tag--open"}`}>{inv.status === "paid" ? "Paid" : inv.status}</span></td></tr>
                  ))}</tbody>
                </table>
              ) : <div className="list__empty">{account.error ? "Invoices aren't available right now." : "No invoices yet."}</div>}
            </section>
          </div>
        </div>
      </div>
    </>
  );
}
