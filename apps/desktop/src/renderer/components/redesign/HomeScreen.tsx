// apps/desktop/src/renderer/components/redesign/HomeScreen.tsx
// Home / mission control: top bar, animated hero (greeting + composer),
// missions list with plain-language reasons, and the "Connect your stack"
// checklist. Presentational — all data and actions come in through props.
import React, { useState } from "react";
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
    agentName = "ORION",
    agentRole = "orchestrator",
    animateHero = true,
  } = props;

  const [prompt, setPrompt] = useState("");
  const [mode, setMode] = useState<ComposerMode>("auto");
  const now = props.now ?? new Date();
  const dateLine = `${now.toLocaleDateString("en-US", { weekday: "long" })} · ${now.getDate()} ${now.toLocaleDateString("en-US", { month: "long" })}`.toUpperCase();

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
            <div className="ov-greeting-row ov-greeting-row--center">
              <div className="ov-greeting ov-greeting--center">
                <div className="ov-eyebrow">{dateLine}</div>
                <h1>
                  {greetingFor(now)}, {userName}.
                </h1>
                <p>{summaryLine(missions)}</p>
              </div>
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

      </main>
    </div>
  );
}
