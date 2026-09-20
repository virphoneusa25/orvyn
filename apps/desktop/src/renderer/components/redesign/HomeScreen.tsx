// apps/desktop/src/renderer/components/redesign/HomeScreen.tsx
// Home / mission control: top bar, animated hero (greeting + composer),
// missions list with plain-language reasons, and the "Connect your stack"
// checklist. Presentational — all data and actions come in through props.
import React, { useMemo, useState } from "react";
import { HeroBackdrop } from "./HeroBackdrop";
import { Icon } from "./icons";
import { TopBar } from "./Shell";
import type {
  ComposerMode,
  EngineStatus,
  MissionFilter,
  MissionSummary,
  SystemItem,
} from "./types";

const MODES: { id: ComposerMode; label: string }[] = [
  { id: "auto", label: "Auto" },
  { id: "code", label: "Code" },
  { id: "server", label: "Server" },
  { id: "research", label: "Research" },
  { id: "deploy", label: "Deploy" },
  { id: "automate", label: "Automate" },
];

const NEEDS_YOU = new Set(["approval", "blocked", "paused"]);

export interface HomeScreenProps {
  userName: string;
  workspaceName: string;
  status: EngineStatus;
  missions: MissionSummary[];
  systems: SystemItem[];
  starters?: string[];
  agentName?: string;
  agentRole?: string;
  /** Show the animated hero background. Default true. */
  animateHero?: boolean;
  /** Override the date line (defaults to today). */
  now?: Date;

  onRun: (prompt: string, mode: ComposerMode) => void;
  onAttach?: () => void;
  onPickAgent?: () => void;
  onOpenMission: (id: string) => void;
  onMissionAction?: (id: string) => void;
  onViewAllMissions?: () => void;
  onConnectSystem?: (id: string) => void;
  onOpenCommand?: () => void;
  onReconnectCloud?: () => void;
  onOpenNotifications?: () => void;
}

function greetingFor(d: Date): string {
  const h = d.getHours();
  if (h < 5) return "Working late";
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

function summaryLine(missions: MissionSummary[]): string {
  const approvals = missions.filter((m) => m.tone === "approval").length;
  const blocked = missions.filter((m) => m.tone === "blocked" || m.tone === "paused").length;
  const total = approvals + blocked;
  if (total === 0) {
    const running = missions.filter((m) => m.tone === "running").length;
    return running > 0
      ? `${running} mission${running === 1 ? " is" : "s are"} running. Nothing needs you right now.`
      : "Nothing needs you right now. What should we work on?";
  }
  const parts: string[] = [];
  if (blocked) parts.push(`${blocked} ${blocked === 1 ? "needs" : "need"} a connection`);
  if (approvals) parts.push(`${approvals} ${approvals === 1 ? "needs" : "need"} your approval`);
  return `${total} mission${total === 1 ? " is" : "s are"} waiting on you — ${parts.join(", ")}.`;
}

export function HomeScreen(props: HomeScreenProps) {
  const {
    userName,
    workspaceName,
    status,
    missions,
    systems,
    starters = ["Diagnose a failing service", "Tail logs on a server", "Review a pull request", "Plan a deploy"],
    agentName = "Astra",
    agentRole = "orchestrator",
    animateHero = true,
  } = props;

  const [prompt, setPrompt] = useState("");
  const [mode, setMode] = useState<ComposerMode>("auto");
  const [filter, setFilter] = useState<MissionFilter>("all");

  const now = props.now ?? new Date();
  const dateLine = `${now.toLocaleDateString("en-US", { weekday: "long" })} · ${now.getDate()} ${now.toLocaleDateString("en-US", { month: "long" })}`.toUpperCase();

  const counts = useMemo(
    () => ({
      all: missions.length,
      needs: missions.filter((m) => NEEDS_YOU.has(m.tone)).length,
      failed: missions.filter((m) => m.tone === "failed").length,
      running: missions.filter((m) => m.tone === "running").length,
    }),
    [missions]
  );

  const visible = missions.filter((m) => {
    if (filter === "needs-you") return NEEDS_YOU.has(m.tone);
    if (filter === "failed") return m.tone === "failed";
    if (filter === "running") return m.tone === "running";
    return true;
  });

  const connected = systems.filter((s) => s.connected).length;

  const submit = () => {
    const text = prompt.trim();
    if (!text) return;
    props.onRun(text, mode);
    setPrompt("");
  };

  return (
    <div className="ov-column">
      <TopBar
        crumbs={[workspaceName, "Home"]}
        status={status}
        onOpenCommand={props.onOpenCommand}
        onReconnectCloud={props.onReconnectCloud}
        onOpenNotifications={props.onOpenNotifications}
      />

      <main className="ov-home">
        {/* ── Hero ── */}
        <section className="ov-hero" aria-label="Start a mission">
          <HeroBackdrop animate={animateHero} />
          <div className="ov-hero__content">
            <div className="ov-greeting-row">
              <div className="ov-greeting">
                <div className="ov-eyebrow">{dateLine}</div>
                <h1>
                  {greetingFor(now)}, {userName}.
                </h1>
                <p>{summaryLine(missions)}</p>
              </div>
              {counts.needs > 0 && (
                <a
                  href="#missions"
                  className="ov-glass-link"
                  onClick={(e) => {
                    e.preventDefault();
                    setFilter("needs-you");
                    document.getElementById("ov-missions")?.scrollIntoView({ behavior: "smooth" });
                  }}
                >
                  Review blocked work →
                </a>
              )}
            </div>

            <div className="ov-composer">
              <label htmlFor="ov-mission-input">New mission</label>
              <textarea
                id="ov-mission-input"
                rows={2}
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                    e.preventDefault();
                    submit();
                  }
                }}
                placeholder="Describe what ORVYN should build, fix, or run — e.g. “Find why BLF presence drops on Yealink phones and propose a fix”"
              />
              <div className="ov-composer__bar">
                <button type="button" className="ov-icon-btn" aria-label="Attach files or context" onClick={props.onAttach}>
                  <Icon name="paperclip" size={16} />
                </button>

                <div className="ov-segmented" role="group" aria-label="Mission mode">
                  {MODES.map((m) => (
                    <button
                      key={m.id}
                      type="button"
                      aria-pressed={mode === m.id}
                      onClick={() => setMode(m.id)}
                    >
                      {m.label}
                    </button>
                  ))}
                </div>

                <button type="button" className="ov-btn ov-agent-select" onClick={props.onPickAgent}>
                  <span className="ov-dot" />
                  {agentName} <span className="ov-agent-select__role">{agentRole}</span>
                  <Icon name="chevronDown" size={12} strokeWidth={2} />
                </button>

                <span className="ov-trust" title="The agent asks for your approval before running commands">
                  <Icon name="shield" size={13} strokeWidth={1.8} />
                  Asks before acting
                </span>

                <button type="button" className="ov-btn ov-btn--primary ov-run" onClick={submit}>
                  Run mission <span className="ov-kbd">Ctrl ↵</span>
                </button>
              </div>
            </div>

            <div className="ov-starters">
              <span>Start from</span>
              {starters.map((s) => (
                <button key={s} type="button" className="ov-chip" onClick={() => setPrompt(s)}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        </section>

        {/* ── Missions + setup ── */}
        <div className="ov-home-grid">
          <section id="ov-missions" className="ov-card" aria-labelledby="ov-missions-h">
            <div className="ov-card__head">
              <h2 id="ov-missions-h">Missions</h2>
              <div className="ov-tabs">
                <button type="button" aria-pressed={filter === "all"} onClick={() => setFilter("all")}>
                  All <span className="ov-tabs__count">{counts.all}</span>
                </button>
                <button type="button" aria-pressed={filter === "needs-you"} onClick={() => setFilter("needs-you")}>
                  Needs you <span className="ov-tabs__count ov-tabs__count--amber">{counts.needs}</span>
                </button>
                <button type="button" aria-pressed={filter === "failed"} onClick={() => setFilter("failed")}>
                  Failed <span className="ov-tabs__count ov-tabs__count--red">{counts.failed}</span>
                </button>
                <button type="button" aria-pressed={filter === "running"} onClick={() => setFilter("running")}>
                  Running <span>{counts.running}</span>
                </button>
              </div>
              <a
                href="#"
                onClick={(e) => {
                  e.preventDefault();
                  props.onViewAllMissions?.();
                }}
              >
                View all
              </a>
            </div>

            {visible.length === 0 ? (
              <div className="ov-empty">No missions here.</div>
            ) : (
              visible.map((m) => {
                const pct = m.stepsTotal ? Math.round((m.stepsDone / m.stepsTotal) * 100) : 0;
                return (
                  <div className="ov-mission-row" key={m.id}>
                    <span className={`ov-badge ov-badge--${m.tone}`}>
                      <span className="ov-dot ov-dot--sm" />
                      {m.label}
                    </span>
                    <div className="ov-mission-row__main">
                      <button type="button" className="ov-mission-row__title" onClick={() => props.onOpenMission(m.id)}>
                        {m.title}
                      </button>
                      <div className="ov-mission-row__reason">{m.reason}</div>
                      <div className="ov-mission-row__meta">{m.meta}</div>
                    </div>
                    <div className="ov-mission-row__progress">
                      <div className="ov-meter">
                        <div className={`ov-fill--${m.tone}`} style={{ width: `${Math.max(pct, 3)}%` }} />
                      </div>
                      <span className="ov-mission-row__steps">
                        {m.stepsDone}/{m.stepsTotal} steps
                      </span>
                    </div>
                    <span className="ov-mission-row__time">{m.timeAgo}</span>
                    {m.action ? (
                      <button
                        type="button"
                        className="ov-btn ov-btn--sm ov-btn--filled"
                        onClick={() => (props.onMissionAction ?? props.onOpenMission)(m.id)}
                      >
                        {m.action}
                      </button>
                    ) : (
                      <span />
                    )}
                  </div>
                );
              })
            )}
          </section>

          <section className="ov-card" aria-labelledby="ov-setup-h">
            <div className="ov-setup__head">
              <div className="ov-setup__title">
                <h2 id="ov-setup-h">Connect your stack</h2>
                <span className="ov-setup__count">
                  {connected} / {systems.length}
                </span>
              </div>
              <div
                className="ov-setup__segments"
                style={{ gridTemplateColumns: `repeat(${Math.max(systems.length, 1)}, minmax(0, 1fr))` }}
              >
                {systems.map((s, i) => (
                  <span key={s.id} className={i < connected ? "is-done" : undefined} />
                ))}
              </div>
              <p>Agents can only act on systems you connect. Each one unlocks more of what ORVYN can do on its own.</p>
            </div>

            {systems.map((s) => (
              <div className="ov-system" key={s.id}>
                <span className="ov-system__icon">
                  <Icon name={s.icon} size={16} />
                </span>
                <div className="ov-system__text">
                  <span className="ov-system__name">{s.name}</span>
                  <span className="ov-system__sub">{s.description}</span>
                </div>
                {s.connected ? (
                  <span className="ov-ready">
                    <Icon name="check" size={14} strokeWidth={2.2} />
                    Ready
                  </span>
                ) : (
                  <button type="button" className="ov-btn ov-btn--sm" onClick={() => props.onConnectSystem?.(s.id)}>
                    {s.cta ?? "Connect"}
                  </button>
                )}
              </div>
            ))}
          </section>
        </div>
      </main>
    </div>
  );
}
