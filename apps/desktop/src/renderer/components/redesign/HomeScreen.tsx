// apps/desktop/src/renderer/components/redesign/HomeScreen.tsx
// Home / mission control: top bar, animated hero (greeting + composer),
// missions list with plain-language reasons, and the "Connect your stack"
// checklist. Presentational — all data and actions come in through props.
import React, { useRef, useState } from "react";
import { HeroBackdrop } from "./HeroBackdrop";
import { Icon } from "./icons";
import { TopBar } from "./Shell";
import { AddMenu, AddPlusButton, ComposerChips, attachmentsFromChips, composerTriggerKey, contextNoteFromChips, type ComposerChip } from "../AddMenu";
import {
  ComposerModePills,
  ComposerSubmitButton,
  useComposerModels,
  ModelMenu,
  ReasoningMenu,
  AccessMenu,
  readComposerDefaults,
  writeComposerDefault,
} from "../ComposerControls";
import type { ReasoningEffort, AccessMode } from "../ComposerControls";
import { IconRocket } from "../Icons";import type {
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

  onRun: (
    prompt: string,
    mode: ComposerMode,
    settings?: {
      attachments?: import("../AttachmentBar").Attachment[];
      contextNote?: string;
      modelId?: string;
      reasoningEffort?: ReasoningEffort;
      permissionMode?: AccessMode;
    }
  ) => void;  onAttach?: () => void;
  projectRoot?: string | null;
  onOpenTerminal?: () => void;
  onNavigate?: (view: string) => void;
  onPickAgent?: () => void;
  onOpenMission: (id: string) => void;
  onMissionAction?: (id: string) => void;
  onViewAllMissions?: () => void;
  onConnectSystem?: (id: string) => void;
  onOpenCommand?: () => void;
  onReconnectCloud?: () => void;
  onOpenNotifications?: () => void;
  /** Overrides the greeting subtitle when the shell has a live connection reading. */
  statusLine?: string;
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
  // Same settings model as the chat composer — ONE defaults reader/writer,
  // no second Home-specific persistence path. A new mission starts a new
  // conversation, which inherits these user defaults.
  const [defaults] = useState(() => readComposerDefaults());
  const [mode, setMode] = useState<ComposerMode>(defaults.mode as ComposerMode);
  const [modelId, setModelId] = useState(defaults.modelId);
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort>(defaults.reasoningEffort);
  const [accessMode, setAccessMode] = useState<AccessMode>(defaults.permissionMode);
  const composerModels = useComposerModels();
  const [addOpen, setAddOpen] = useState(false);
  const [chips, setChips] = useState<ComposerChip[]>([]);
  const plusRef = useRef<HTMLButtonElement>(null);  const now = props.now ?? new Date();
  const dateLine = `${now.toLocaleDateString("en-US", { weekday: "long" })} · ${now.getDate()} ${now.toLocaleDateString("en-US", { month: "long" })}`.toUpperCase();

  const submit = () => {
    const text = prompt.trim();
    if (!text) return;
    props.onRun(text, mode, {
      attachments: attachmentsFromChips(chips),
      contextNote: contextNoteFromChips(chips) || undefined,
      modelId,
      reasoningEffort,
      permissionMode: accessMode,    });
    setPrompt("");
    setChips([]);
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
                <p>{props.statusLine ?? summaryLine(missions)}</p>
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
                    return;
                  }
                  const trigger = composerTriggerKey(e.key);
                  if (trigger && !e.ctrlKey && !e.metaKey && !e.altKey) {
                    const el = e.currentTarget;
                    const atEdge = el.selectionStart === 0 || /\s/.test(el.value[el.selectionStart - 1] ?? " ");
                    if (atEdge) {
                      e.preventDefault();
                      setAddOpen(true);
                    }
                  }
                }}
                placeholder="Describe what ORVYN should build, fix, or run — e.g. “Find why BLF presence drops on Yealink phones and propose a fix”"
              />
              {chips.length > 0 && (
                <div style={{ padding: "0 16px 8px" }}>
                  <ComposerChips chips={chips} onRemove={(id) => setChips((prev) => prev.filter((c) => c.id !== id))} />
                </div>
              )}
              {/* Control row — the SAME shared components as the chat
                  composer: add-menu, pills, shield, model, brain, submit.
                  ORION is the implied agent (the model selector names the
                  actual model). */}
              <div className="ov-composer__bar">
                <AddPlusButton open={addOpen} onClick={() => setAddOpen((v) => !v)} buttonRef={plusRef} />
                <AddMenu
                  open={addOpen}
                  onOpenChange={setAddOpen}
                  selected={chips}
                  onSelectedChange={setChips}
                  onOpenTerminal={props.onOpenTerminal}
                  onNavigate={props.onNavigate}
                  projectRoot={props.projectRoot ?? null}
                  anchorRef={plusRef}
                />
                <ComposerModePills
                  mode={mode}
                  onChange={(m) => {
                    setMode(m as ComposerMode);
                    writeComposerDefault("mode", m);
                  }}
                />

                <AccessMenu
                  value={accessMode}
                  onChange={(v) => {
                    setAccessMode(v);
                    writeComposerDefault("permissionMode", v);
                  }}
                />
                <ModelMenu
                  models={composerModels}
                  value={modelId}
                  onChange={(id) => {
                    setModelId(id);
                    writeComposerDefault("modelId", id);
                  }}
                />
                <ReasoningMenu
                  value={reasoningEffort}
                  models={composerModels}
                  modelId={modelId}
                  onChange={(v) => {
                    setReasoningEffort(v);
                    writeComposerDefault("reasoningEffort", v);
                  }}
                />

                <ComposerSubmitButton
                  label="Run mission"
                  icon={<IconRocket size={13} />}
                  onClick={submit}
                  disabled={!prompt.trim()}
                  title="Run mission (Ctrl+Enter)"
                />
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
