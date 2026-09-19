// apps/desktop/src/renderer/components/Home.tsx
//
// The approved mockup's Home workspace. Composition at 1920×1080 (no scroll):
// hero (logo, cosmic background, centered greeting, elevated composer)
// → quick actions (six icon-tile cards, ONE row)
// → recent missions (≈62%) beside connected systems (≈38%)
// → the real activity/terminal dock filling the rest.
// Every value is live; the mockup controls presentation, real state controls
// content — "Not connected" stays "Not connected".
import React, { useCallback, useEffect, useRef, useState } from "react";
import { apiUrl, authHeaders } from "../connection";
import { submitOrvynCommand } from "../orvynCommand";
import { IconRocket, IconZap, IconWrench, IconGlobe, IconServer, IconCode, IconReport, IconPaperclip } from "./Icons";
import { BottomWorkPanel } from "./BottomWorkPanel";
import { HeroBackground } from "./HeroBackground";
import { Attachment, fileToAttachment } from "./AttachmentBar";
import { IntegrationIcon, IntegrationProvider } from "./IntegrationIcon";
import appIcon from "../assets/icon.png";

type ComposerMode = "auto" | "code" | "server" | "research" | "deploy" | "automate";

const MODES: { id: ComposerMode; label: string; hint: string }[] = [
  { id: "auto", label: "Auto", hint: "ORVYN decides: chat, task, or mission" },
  { id: "code", label: "Code", hint: "Plan, code, test in the workspace" },
  { id: "server", label: "Server", hint: "SSH into an allow-listed server" },
  { id: "research", label: "Research", hint: "Investigate and report, no edits" },
  { id: "deploy", label: "Deploy", hint: "Build and deploy" },
  { id: "automate", label: "Automate", hint: "Recurring task (scheduler pending)" },
];

const QUICK_ACTIONS: { id: ComposerMode; title: string; desc: string; Icon: React.FC<{ size?: number }>; tile: string }[] = [
  { id: "code", title: "Build Feature", desc: "Plan, code, test, and commit", Icon: IconCode, tile: "#6C5CFF" },
  { id: "code", title: "Fix Problem", desc: "Find and resolve issues", Icon: IconWrench, tile: "#F25F75" },
  { id: "server", title: "Server Task", desc: "SSH, logs, diagnose, fix", Icon: IconServer, tile: "#22D3EE" },
  { id: "deploy", title: "Deploy App", desc: "Build and deploy", Icon: IconRocket, tile: "#20D89B" },
  { id: "research", title: "Research", desc: "Browse, analyze, report", Icon: IconReport, tile: "#4DA3FF" },
  { id: "automate", title: "Automate", desc: "Create a recurring task", Icon: IconZap, tile: "#F5B942" },
];

interface MissionRow {
  id: string;
  /** The RunStore run whose events back this mission's Active Workspace. */
  runId?: string;
  goal: string;
  status: string;
  createdAt: string;
  tasks?: { status: string }[];
}

interface ServerRow {
  alias: string;
  host: string;
  user: string;
  port: number;
}

function greeting(): string {
  const h = new Date().getHours();
  if (h < 5) return "Working late";
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

function relTime(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

const STATUS_STYLE: Record<string, { color: string; label: string }> = {
  COMPLETED: { color: "var(--orvyn-green)", label: "COMPLETED" },
  RUNNING: { color: "var(--orvyn-purple-hi)", label: "RUNNING" },
  PLANNING: { color: "var(--orvyn-purple-hi)", label: "PLANNING" },
  REVIEW: { color: "var(--orvyn-yellow)", label: "REVIEW" },
  BLOCKED: { color: "var(--orvyn-yellow)", label: "BLOCKED" },
  FAILED: { color: "var(--orvyn-red)", label: "FAILED" },
};

export function Home({
  projectRoot,
  onOutcome,
}: {
  projectRoot: string | null;
  /** Called with the pipeline result so the shell can follow the work. */
  onOutcome: (outcome: { kind: "chat" } | { kind: "mission" | "run"; runId: string }) => void;
}) {
  // Default Code per the approved mockup; the user's choice persists.
  const [prompt, setPrompt] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [mode, setMode] = useState<ComposerMode>(() => {
    // AUTO is the fresh default (intent-first); a saved explicit choice is
    // the user's override and is honored.
    const saved = localStorage.getItem("orvyn:composer-mode");
    return saved && MODES.some((m) => m.id === saved) ? (saved as ComposerMode) : "auto";
  });
  const selectMode = (m: ComposerMode) => {
    setMode(m);
    localStorage.setItem("orvyn:composer-mode", m);
  };
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [missions, setMissions] = useState<MissionRow[]>([]);
  const [servers, setServers] = useState<ServerRow[]>([]);
  const [backendOnline, setBackendOnline] = useState<boolean | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const attachRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    try {
      const headers = authHeaders();
      const root = projectRoot ? `?projectRoot=${encodeURIComponent(projectRoot)}` : "";
      const [m, s, h] = await Promise.all([
        fetch(apiUrl("/missions"), { headers }).then((r) => r.json()).catch(() => ({ missions: [] })),
        fetch(apiUrl(`/servers${root}`), { headers }).then((r) => r.json()).catch(() => ({ servers: [] })),
        fetch(apiUrl("/../api/v1/health")).then((r) => r.ok).catch(() => false),
      ]);
      setMissions((m.missions ?? []).slice(0, 6));
      setServers(s.servers ?? []);
      setBackendOnline(Boolean(h));
    } catch {
      setBackendOnline(false);
    }
  }, [projectRoot]);

  useEffect(() => {
    void refresh();
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, [refresh]);

  async function run(text?: string) {
    const instruction = (text ?? prompt).trim();
    if (!instruction || starting) return;
    setStarting(true);
    setStartError(null);
    try {
      // The canonical pipeline — classification, routing and error handling
      // live in orvynCommand, not here.
      const outcome = await submitOrvynCommand({
        prompt: instruction,
        mode,
        source: "HOME",
        projectRoot,
        attachments,
      });
      if (outcome.kind === "error") throw new Error(outcome.error);
      setPrompt("");
      setAttachments([]);
      onOutcome(outcome);
    } catch (err: any) {
      // Keep the user's command in the field on failure — never erase it.
      setStartError(err.message);
    } finally {
      setStarting(false);
    }
  }

  function applyQuickAction(a: (typeof QUICK_ACTIONS)[number]) {
    selectMode(a.id);
    const templates: Record<string, string> = {
      "Build Feature": "Build this feature: ",
      "Fix Problem": "Investigate and fix this problem: ",
      "Server Task": "Connect to my server over SSH and diagnose: ",
      "Deploy App": "Deploy this application: ",
      Research: "Research this and produce a report: ",
      Automate: "Set up a recurring task that: ",
    };
    setPrompt(templates[a.title] ?? "");
    inputRef.current?.focus();
  }

  return (
    <div
      style={{
        height: "100%",
        minWidth: 0,
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        background: "var(--orvyn-surface-1)",
      }}
    >
      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "18px 26px 16px" }}>
        {/* ── HERO ─────────────────────────────────────────────── */}
        <div
          style={{
            position: "relative",
            borderRadius: "var(--orvyn-radius-lg)",
            border: "1px solid var(--orvyn-border-soft)",
            overflow: "hidden",
            padding: "26px 32px 20px",
            marginBottom: 12,
            background: "var(--orvyn-surface-2)",
          }}
        >
          {/* Animated space/network treatment — canvas layers (nebula glow,
              drifting stars, pulsing network). Frozen under
              prefers-reduced-motion; clipped inside the hero. */}
          <HeroBackground />

          <div style={{ position: "relative", display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center" }}>
            <img src={appIcon} alt="ORVYN" width={46} height={46} style={{ borderRadius: 12, marginBottom: 10, boxShadow: "0 8px 28px rgba(108,92,255,0.35)" }} />
            <div style={{ fontSize: 22, fontWeight: 700, color: "var(--orvyn-text)", letterSpacing: -0.3 }}>
              {greeting()}.
            </div>
            <div style={{ fontSize: 12.5, color: "var(--orvyn-text-secondary)", marginTop: 4, marginBottom: 14 }}>
              Your AI engineering co-worker is ready.
            </div>

            {/* Elevated composer */}
            <div
              style={{
                width: "min(760px, 100%)",
                background: "var(--orvyn-bg)",
                border: "1px solid var(--orvyn-border)",
                borderRadius: "var(--orvyn-radius-lg)",
                boxShadow: "0 16px 40px rgba(3,6,14,0.5)",
                padding: 12,
              }}
            >
              <textarea
                ref={inputRef}
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={(e) => {
                  // Enter runs, Shift+Enter breaks a line — the approved model.
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void run();
                  }
                }}
                rows={2}
                placeholder="What do you want ORVYN to accomplish?"
                style={{
                  width: "100%",
                  background: "transparent",
                  border: "none",
                  outline: "none",
                  color: "var(--orvyn-text)",
                  padding: "4px 6px",
                  fontSize: 13.5,
                  resize: "none",
                  fontFamily: "inherit",
                }}
              />
              <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 6, flexWrap: "wrap" }}>
                <button
                  title="Attach files or images"
                  onClick={() => attachRef.current?.click()}
                  style={{
                    background: "transparent",
                    border: "1px solid var(--orvyn-border)",
                    borderRadius: 6,
                    color: "var(--orvyn-text-secondary)",
                    width: 26,
                    height: 26,
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    cursor: "pointer",
                    flexShrink: 0,
                  }}
                >
                  <IconPaperclip size={13} />
                </button>
                <input
                  ref={attachRef}
                  type="file"
                  multiple
                  style={{ display: "none" }}
                  onChange={async (e) => {
                    const files = Array.from(e.target.files ?? []);
                    const loaded: Attachment[] = [];
                    for (const f of files) {
                      try {
                        const a = await fileToAttachment(f);
                        if (a) loaded.push(a);
                      } catch {
                        // Unreadable file — skip rather than block the rest.
                      }
                    }
                    setAttachments((prev) => [...prev, ...loaded]);
                    e.target.value = "";
                  }}
                />
                {attachments.length > 0 && (
                  <span style={{ fontSize: 11, color: "var(--orvyn-cyan)" }}>
                    {attachments.length} attached
                  </span>
                )}
                {MODES.map((m) => (
                  <button
                    key={m.id}
                    title={m.hint}
                    onClick={() => selectMode(m.id)}
                    style={{
                      background: mode === m.id ? "var(--orvyn-purple)" : "transparent",
                      border: `1px solid ${mode === m.id ? "var(--orvyn-purple)" : "var(--orvyn-border)"}`,
                      borderRadius: 999,
                      color: mode === m.id ? "#fff" : "var(--orvyn-text-secondary)",
                      padding: "4px 12px",
                      fontSize: 11.5,
                      cursor: "pointer",
                    }}
                  >
                    {m.label}
                  </button>
                ))}
                <span style={{ fontSize: 11, color: "var(--orvyn-text-muted)", marginLeft: 4 }}>
                  Agent: Astra
                </span>
                <button
                  onClick={() => void run()}
                  disabled={!prompt.trim() || starting}
                  style={{
                    marginLeft: "auto",
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 7,
                    background: "var(--orvyn-purple)",
                    border: "none",
                    borderRadius: "var(--orvyn-radius-sm)",
                    color: "#fff",
                    padding: "8px 26px",
                    fontSize: 13,
                    fontWeight: 600,
                    cursor: !prompt.trim() || starting ? "default" : "pointer",
                    opacity: !prompt.trim() || starting ? 0.55 : 1,
                    boxShadow: "0 6px 18px rgba(108,92,255,0.4)",
                  }}
                >
                  <IconRocket size={14} /> {starting ? "Starting…" : "Run"}
                </button>
              </div>
            </div>
            {startError && <div style={{ color: "var(--orvyn-red)", fontSize: 12, marginTop: 8 }}>{startError}</div>}
            {!projectRoot && (
              <div style={{ fontSize: 11.5, color: "var(--orvyn-yellow)", marginTop: 8 }}>
                No project open — running against the built-in workspace. Open a folder from Projects for real work.
              </div>
            )}
          </div>
        </div>

        {/* ── QUICK ACTIONS — one row of six, never clipped ──── */}
        <div
          style={{
            display: "grid",
            // minmax(0,1fr) is the fix for cards rendering under the AI
            // panel: plain 1fr means minmax(auto,1fr), so card content could
            // force the track wider than the center workspace.
            gridTemplateColumns: "repeat(6, minmax(0, 1fr))",
            gap: 10,
            marginBottom: 14,
          }}
        >
          {QUICK_ACTIONS.map((a) => (
            <button
              key={a.title}
              onClick={() => applyQuickAction(a)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                textAlign: "left",
                background: "var(--orvyn-surface-2)",
                border: "1px solid var(--orvyn-border-soft)",
                borderRadius: "var(--orvyn-radius-md)",
                padding: "10px 12px",
                minHeight: 58,
                cursor: "pointer",
                color: "var(--orvyn-text)",
                transition: "border-color 130ms ease, transform 130ms ease",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.borderColor = "var(--orvyn-purple)";
                e.currentTarget.style.transform = "translateY(-1px)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.borderColor = "var(--orvyn-border-soft)";
                e.currentTarget.style.transform = "none";
              }}
            >
              <span
                style={{
                  width: 32,
                  height: 32,
                  flexShrink: 0,
                  borderRadius: 8,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  background: `${a.tile}1f`,
                  color: a.tile,
                  border: `1px solid ${a.tile}33`,
                }}
              >
                <a.Icon size={16} />
              </span>
              <span style={{ minWidth: 0 }}>
                <span style={{ display: "block", fontSize: 12, fontWeight: 600, letterSpacing: 0.2 }}>{a.title}</span>
                <span style={{ display: "block", fontSize: 10.5, color: "var(--orvyn-text-muted)", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {a.desc}
                </span>
              </span>
            </button>
          ))}
        </div>

        {/* ── MISSIONS (≈62%) + SYSTEMS (≈38%) side by side ────── */}
        <div style={{ display: "grid", gridTemplateColumns: "minmax(0,62fr) minmax(0,38fr)", gap: 12, alignItems: "start" }}>
          <Panel title="RECENT MISSIONS" right="View All" onRight={() => document.dispatchEvent(new CustomEvent("orvyn:nav", { detail: "missions" }))}>
            {missions.length === 0 ? (
              <Empty>No missions yet — tell ORVYN what you want accomplished above.</Empty>
            ) : (
              missions.map((m) => {
                const total = m.tasks?.length ?? 0;
                const done = m.tasks?.filter((t) => t.status === "COMPLETED").length ?? 0;
                const pct = total > 0 ? Math.round((done / total) * 100) : m.status === "COMPLETED" ? 100 : 0;
                const st = STATUS_STYLE[m.status] ?? { color: "var(--orvyn-purple-hi)", label: m.status };
                return (
                  <div
                    key={m.id}
                    style={{ ...rowStyle(), cursor: "pointer" }}
                    title="Open this mission's workspace"
                    onClick={() =>
                      m.runId
                        ? document.dispatchEvent(new CustomEvent("orvyn:open-run", { detail: m.runId }))
                        : document.dispatchEvent(new CustomEvent("orvyn:nav", { detail: "missions" }))
                    }
                  >
                    <span style={{ minWidth: 0, flex: 1 }}>
                      <span style={{ display: "block", fontSize: 12.5, color: "var(--orvyn-text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {m.goal}
                      </span>
                      <span style={{ display: "block", fontSize: 10.5, color: "var(--orvyn-text-muted)", marginTop: 2, fontFamily: "var(--font-mono)" }}>
                        {m.id.slice(0, 12)} · {total > 0 ? `${done}/${total} steps` : "no steps"}
                      </span>
                    </span>
                    <span style={{ ...badge(st.color), flexShrink: 0 }}>{st.label}</span>
                    <span style={{ width: 84, display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
                      <span style={{ flex: 1, height: 4, borderRadius: 2, background: "var(--orvyn-border)", overflow: "hidden" }}>
                        <span style={{ display: "block", width: `${pct}%`, height: "100%", background: "var(--orvyn-purple)" }} />
                      </span>
                      <span style={{ fontSize: 10.5, color: "var(--orvyn-text-muted)", minWidth: 28 }}>{pct}%</span>
                    </span>
                    <span style={{ fontSize: 10.5, color: "var(--orvyn-text-muted)", width: 56, textAlign: "right", flexShrink: 0 }}>
                      {relTime(m.createdAt)}
                    </span>
                  </div>
                );
              })
            )}
          </Panel>

          <Panel title="CONNECTED SYSTEMS" right="Manage" onRight={() => document.dispatchEvent(new CustomEvent("orvyn:nav", { detail: "servers" }))}>
            <SystemRow
              name="ORVYN Backend"
              detail={backendOnline === null ? "checking…" : backendOnline ? "API reachable" : "offline"}
              status={backendOnline === null ? "pending" : backendOnline ? "ok" : "down"}
              provider="orvyn"
              onClick={() => document.dispatchEvent(new CustomEvent("orvyn:nav", { detail: "settings" }))}
            />
            {servers.map((s) => (
              <SystemRow
                key={s.alias}
                name={s.alias}
                detail={`${s.user}@${s.host}`}
                status="configured"
                provider="server"
                onClick={() => document.dispatchEvent(new CustomEvent("orvyn:nav", { detail: "servers" }))}
              />
            ))}
            {servers.length === 0 && (
              <SystemRow
                name="Servers"
                detail="No SSH host configured"
                status="none"
                provider="server"
                onClick={() => document.dispatchEvent(new CustomEvent("orvyn:nav", { detail: "servers" }))}
              />
            )}
            <SystemRow
              name="Docker"
              detail="No Docker host connected"
              status="none"
              provider="docker"
              onClick={() => document.dispatchEvent(new CustomEvent("orvyn:nav", { detail: "containers" }))}
            />
            <SystemRow
              name="PostgreSQL"
              detail="No database configured"
              status="none"
              provider="postgresql"
              onClick={() => document.dispatchEvent(new CustomEvent("orvyn:nav", { detail: "databases" }))}
            />
            <SystemRow
              name="GitHub"
              detail="Repository & PR integration"
              status="none"
              provider="github"
              onClick={() => document.dispatchEvent(new CustomEvent("orvyn:nav", { detail: "scm" }))}
            />
            <SystemRow
              name="Stripe"
              detail="Billing & payments (Phase D–E)"
              status="none"
              provider="stripe"
              onClick={() => document.dispatchEvent(new CustomEvent("orvyn:nav", { detail: "billing" }))}
            />
          </Panel>
        </div>
      </div>

      {/* ── TERMINAL / ACTIVITY dock — target composition ────── */}
      <BottomWorkPanel height={176} />
    </div>
  );
}

function Panel({
  title,
  right,
  onRight,
  children,
}: {
  title: string;
  right?: string;
  onRight?: () => void;
  children: React.ReactNode;
}) {
  return (
    <div
      style={{
        background: "var(--orvyn-surface-2)",
        border: "1px solid var(--orvyn-border-soft)",
        borderRadius: "var(--orvyn-radius-md)",
        padding: "6px 14px 8px",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", padding: "8px 0 4px" }}>
        <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: 1.4, color: "var(--orvyn-text-muted)" }}>
          {title}
        </span>
        {right && (
          <button
            onClick={onRight}
            style={{ marginLeft: "auto", background: "none", border: "none", color: "var(--orvyn-purple-hi)", fontSize: 11, cursor: "pointer" }}
          >
            {right}
          </button>
        )}
      </div>
      {children}
    </div>
  );
}

function SystemRow({
  name,
  detail,
  status,
  provider,
  onClick,
}: {
  name: string;
  detail: string;
  status: "ok" | "down" | "configured" | "none" | "pending";
  provider: IntegrationProvider;
  onClick?: () => void;
}) {
  const color =
    status === "ok" ? "var(--orvyn-green)"
    : status === "down" ? "var(--orvyn-red)"
    : status === "configured" ? "var(--orvyn-blue)"
    : status === "pending" ? "var(--orvyn-text-muted)"
    : "var(--orvyn-text-muted)";
  const label =
    status === "ok" ? "Online" : status === "down" ? "Offline" : status === "configured" ? "Configured" : status === "pending" ? "…" : "Not connected";
  return (
    <div
      onClick={onClick}
      title={onClick ? "Open" : undefined}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 11,
        padding: "8px 0",
        borderBottom: "1px solid var(--orvyn-border-soft)",
        cursor: onClick ? "pointer" : "default",
      }}
    >
      <span
        style={{
          width: 30,
          height: 30,
          flexShrink: 0,
          borderRadius: 7,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "var(--orvyn-surface-3)",
          border: "1px solid var(--orvyn-border-soft)",
        }}
      >
        <IntegrationIcon provider={provider} size={18} />
      </span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: "block", fontSize: 12.5, color: "var(--orvyn-text)" }}>{name}</span>
        <span style={{ display: "block", fontSize: 10.5, color: "var(--orvyn-text-muted)", marginTop: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {detail}
        </span>
      </span>
      <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 11, color, flexShrink: 0 }}>
        <span style={{ width: 6, height: 6, borderRadius: "50%", background: color }} />
        {label}
      </span>
    </div>
  );
}

function badge(color: string): React.CSSProperties {
  return {
    fontSize: 9.5,
    fontWeight: 700,
    letterSpacing: 0.8,
    color,
    border: `1px solid ${color}55`,
    borderRadius: 4,
    padding: "2px 7px",
  };
}

function rowStyle(): React.CSSProperties {
  return {
    display: "flex",
    alignItems: "center",
    gap: 12,
    padding: "9px 0",
    borderBottom: "1px solid var(--orvyn-border-soft)",
  };
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 12, color: "var(--orvyn-text-muted)", padding: "12px 0" }}>{children}</div>;
}
