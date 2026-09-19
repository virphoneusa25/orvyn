// apps/desktop/src/renderer/components/Home.tsx
//
// The approved mockup's Home workspace: ORVYN's landing surface. The task
// composer starts REAL missions; quick actions prefill real modes; Recent
// Missions and Connected Systems show live state. Per the no-fake rule the
// greeting has no fabricated user name (no account system yet) and every
// "Not connected" row is the truth.
import React, { useCallback, useEffect, useRef, useState } from "react";
import { apiUrl, authHeaders } from "../connection";
import { IconRocket, IconZap, IconWrench, IconGlobe, IconServer, IconCode } from "./Icons";

type ComposerMode = "code" | "server" | "research" | "deploy" | "automate";

const MODES: { id: ComposerMode; label: string; hint: string }[] = [
  { id: "code", label: "Code", hint: "Plan, code, test in the workspace" },
  { id: "server", label: "Server", hint: "SSH into an allow-listed server" },
  { id: "research", label: "Research", hint: "Investigate and report, no edits" },
  { id: "deploy", label: "Deploy", hint: "Build and deploy" },
  { id: "automate", label: "Automate", hint: "Recurring task (scheduler pending)" },
];

const QUICK_ACTIONS: { id: ComposerMode; title: string; desc: string }[] = [
  { id: "code", title: "BUILD FEATURE", desc: "Plan, code, test, and commit" },
  { id: "code", title: "FIX PROBLEM", desc: "Find and resolve issues" },
  { id: "server", title: "SERVER TASK", desc: "SSH, logs, diagnose, fix" },
  { id: "deploy", title: "DEPLOY APP", desc: "Build and deploy" },
  { id: "research", title: "RESEARCH", desc: "Browse, analyze, report" },
  { id: "automate", title: "AUTOMATE", desc: "Create a recurring task" },
];

interface MissionRow {
  id: string;
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

export function Home({
  projectRoot,
  onMissionStarted,
}: {
  projectRoot: string | null;
  onMissionStarted: () => void;
}) {
  const [prompt, setPrompt] = useState("");
  const [mode, setMode] = useState<ComposerMode>("code");
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [missions, setMissions] = useState<MissionRow[]>([]);
  const [servers, setServers] = useState<ServerRow[]>([]);
  const [backendOnline, setBackendOnline] = useState<boolean | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const refresh = useCallback(async () => {
    try {
      const headers = authHeaders();
      const root = projectRoot ? `?projectRoot=${encodeURIComponent(projectRoot)}` : "";
      const [m, s, h] = await Promise.all([
        fetch(apiUrl("/missions"), { headers }).then((r) => r.json()).catch(() => ({ missions: [] })),
        fetch(apiUrl(`/servers${root}`), { headers }).then((r) => r.json()).catch(() => ({ servers: [] })),
        fetch(apiUrl("/../api/v1/health")).then((r) => r.ok).catch(() => false),
      ]);
      setMissions((m.missions ?? []).slice(0, 5));
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
      // The composer creates real work: missions through the orchestrator,
      // except research/automate which start as read-only agent runs.
      const endpoint = mode === "research" || mode === "automate" ? "/agent/stream/runs" : "/agent/orchestrate";
      const body =
        endpoint === "/agent/orchestrate"
          ? { projectRoot, goal: instruction }
          : { projectRoot, instruction, mode: "plan" };
      const res = await fetch(apiUrl(endpoint), {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not start the task");
      setPrompt("");
      onMissionStarted();
    } catch (err: any) {
      setStartError(err.message);
    } finally {
      setStarting(false);
    }
  }

  function applyQuickAction(a: { id: ComposerMode; title: string }) {
    setMode(a.id);
    const templates: Record<string, string> = {
      "BUILD FEATURE": "Build this feature: ",
      "FIX PROBLEM": "Investigate and fix this problem: ",
      "SERVER TASK": "Connect to my server over SSH and diagnose: ",
      "DEPLOY APP": "Deploy this application: ",
      RESEARCH: "Research this and produce a report: ",
      AUTOMATE: "Set up a recurring task that: ",
    };
    setPrompt(templates[a.title] ?? "");
    inputRef.current?.focus();
  }

  return (
    <div style={{ height: "100%", overflowY: "auto", padding: "28px 32px", minWidth: 0 }}>
      {/* Hero */}
      <div style={{ marginBottom: 22 }}>
        <div style={{ fontSize: 22, fontWeight: 700, color: "var(--orvyn-text)" }}>
          {greeting()}.
        </div>
        <div style={{ fontSize: 13, color: "var(--orvyn-text-secondary)", marginTop: 4 }}>
          Your AI engineering co-worker is ready.
        </div>
      </div>

      {/* Task composer */}
      <div
        style={{
          background: "var(--orvyn-surface-2)",
          border: "1px solid var(--orvyn-border-soft)",
          borderRadius: "var(--orvyn-radius-lg)",
          padding: 14,
          marginBottom: 18,
        }}
      >
        <textarea
          ref={inputRef}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              void run();
            }
          }}
          rows={3}
          placeholder="Tell ORVYN what you want to accomplish…"
          style={{
            width: "100%",
            background: "var(--orvyn-bg)",
            border: "1px solid var(--orvyn-border-soft)",
            borderRadius: "var(--orvyn-radius-md)",
            color: "var(--orvyn-text)",
            padding: "10px 12px",
            fontSize: 13.5,
            resize: "vertical",
            fontFamily: "inherit",
          }}
        />
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 10, flexWrap: "wrap" }}>
          {MODES.map((m) => (
            <button
              key={m.id}
              title={m.hint}
              onClick={() => setMode(m.id)}
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
              padding: "7px 22px",
              fontSize: 12.5,
              fontWeight: 600,
              cursor: !prompt.trim() || starting ? "default" : "pointer",
              opacity: !prompt.trim() || starting ? 0.5 : 1,
            }}
          >
            <IconRocket size={13} /> {starting ? "Starting…" : "Run"}
          </button>
        </div>
        {startError && <div style={{ color: "var(--orvyn-red)", fontSize: 12, marginTop: 8 }}>{startError}</div>}
        {!projectRoot && (
          <div style={{ fontSize: 11.5, color: "var(--orvyn-yellow)", marginTop: 8 }}>
            No project open — running against the built-in workspace. Open a folder from Projects for real work.
          </div>
        )}
      </div>

      {/* Quick actions */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(170px, 1fr))", gap: 10, marginBottom: 22 }}>
        {QUICK_ACTIONS.map((a) => (
          <button
            key={a.title}
            onClick={() => applyQuickAction(a)}
            style={{
              textAlign: "left",
              background: "var(--orvyn-surface-2)",
              border: "1px solid var(--orvyn-border-soft)",
              borderRadius: "var(--orvyn-radius-md)",
              padding: "12px 14px",
              cursor: "pointer",
              color: "var(--orvyn-text)",
              transition: "border-color 120ms ease",
            }}
            onMouseEnter={(e) => (e.currentTarget.style.borderColor = "var(--orvyn-purple)")}
            onMouseLeave={(e) => (e.currentTarget.style.borderColor = "var(--orvyn-border-soft)")}
          >
            <div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: 1, color: "var(--orvyn-purple-hi)" }}>
              {a.title}
            </div>
            <div style={{ fontSize: 11.5, color: "var(--orvyn-text-muted)", marginTop: 4 }}>{a.desc}</div>
          </button>
        ))}
      </div>

      {/* Recent missions */}
      <Section title="RECENT MISSIONS" right="View All" onRight={() => {/* Missions nav item */}}>
        {missions.length === 0 ? (
          <Empty>No missions yet — tell ORVYN what you want accomplished above.</Empty>
        ) : (
          missions.map((m) => {
            const total = m.tasks?.length ?? 0;
            const done = m.tasks?.filter((t) => t.status === "COMPLETED").length ?? 0;
            const pct = total > 0 ? Math.round((done / total) * 100) : m.status === "COMPLETED" ? 100 : 0;
            return (
              <div key={m.id} style={rowStyle()}>
                <span style={{ ...statusDot(m.status), minWidth: 86 }}>● {m.status}</span>
                <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 12 }}>
                  {m.goal}
                </span>
                <span style={{ width: 90, display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
                  <span style={{ flex: 1, height: 3, borderRadius: 2, background: "var(--orvyn-border)", overflow: "hidden" }}>
                    <span style={{ display: "block", width: `${pct}%`, height: "100%", background: "var(--orvyn-purple)" }} />
                  </span>
                  <span style={{ fontSize: 10.5, color: "var(--orvyn-text-muted)" }}>{pct}%</span>
                </span>
                <span style={{ fontSize: 11, color: "var(--orvyn-text-muted)", width: 62, textAlign: "right", flexShrink: 0 }}>
                  {new Date(m.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                </span>
              </div>
            );
          })
        )}
      </Section>

      {/* Connected systems */}
      <Section title="CONNECTED SYSTEMS">
        <SystemRow
          name="ORVYN Backend"
          detail={backendOnline === null ? "checking…" : backendOnline ? "API reachable" : "offline"}
          status={backendOnline === null ? "pending" : backendOnline ? "ok" : "down"}
        />
        {servers.map((s) => (
          <SystemRow key={s.alias} name={s.alias} detail={`${s.host} · ${s.user}@:${s.port}`} status="configured" />
        ))}
        {servers.length === 0 && (
          <SystemRow name="Servers" detail="No SSH hosts configured (.orvyn/ssh.json)" status="none" />
        )}
        <SystemRow name="GitHub" detail="Repository & PR integration" status="none" />
        <SystemRow name="Billing" detail="Commercial backend (Phase D–E)" status="none" />
      </Section>
    </div>
  );
}

function Section({
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
    <div style={{ marginBottom: 22 }}>
      <div style={{ display: "flex", alignItems: "center", marginBottom: 8 }}>
        <span style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: 1.2, color: "var(--orvyn-text-muted)" }}>
          {title}
        </span>
        {right && (
          <button
            onClick={onRight}
            style={{ marginLeft: "auto", background: "none", border: "none", color: "var(--orvyn-purple-hi)", fontSize: 11.5, cursor: "pointer" }}
          >
            {right}
          </button>
        )}
      </div>
      <div style={{ background: "var(--orvyn-surface-2)", border: "1px solid var(--orvyn-border-soft)", borderRadius: "var(--orvyn-radius-md)", padding: "4px 12px" }}>
        {children}
      </div>
    </div>
  );
}

function SystemRow({ name, detail, status }: { name: string; detail: string; status: "ok" | "down" | "configured" | "none" | "pending" }) {
  const color =
    status === "ok" ? "var(--orvyn-green)"
    : status === "down" ? "var(--orvyn-red)"
    : status === "configured" ? "var(--orvyn-blue)"
    : status === "pending" ? "var(--orvyn-text-muted)"
    : "var(--orvyn-text-muted)";
  const label =
    status === "ok" ? "Online" : status === "down" ? "Offline" : status === "configured" ? "Configured" : status === "pending" ? "…" : "Not connected";
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 0", borderBottom: "1px solid var(--orvyn-border-soft)" }}>
      <span style={{ fontSize: 12.5, minWidth: 130, color: "var(--orvyn-text)" }}>{name}</span>
      <span style={{ fontSize: 11.5, color: "var(--orvyn-text-muted)", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {detail}
      </span>
      <span style={{ fontSize: 11, color, flexShrink: 0 }}>{label}</span>
    </div>
  );
}

function statusDot(status: string): React.CSSProperties {
  const color =
    status === "COMPLETED" ? "var(--orvyn-green)"
    : status === "FAILED" ? "var(--orvyn-red)"
    : status === "BLOCKED" ? "var(--orvyn-yellow)"
    : "var(--orvyn-purple-hi)";
  return { fontSize: 11.5, color, fontWeight: 600 };
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
  return <div style={{ fontSize: 12, color: "var(--orvyn-text-muted)", padding: "10px 0" }}>{children}</div>;
}
