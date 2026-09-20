// apps/desktop/src/renderer/components/Workspaces.tsx
//
// Real-data workspaces for the Infrastructure and AI nav sections. Servers
// reads .orvyn/ssh.json through the backend (no key material) and can run a
// REAL health check through the approval-gated tool route; Tools lists the
// live gateway registry; Agents lists the live roster with routed models.
import React, { useCallback, useEffect, useState } from "react";
import { apiUrl, authHeaders } from "../connection";
import { HonestState } from "./HonestState";

function Shell({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <div style={{ height: "100%", overflowY: "auto", padding: "22px 26px", minWidth: 0 }}>
      <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 2 }}>{title}</div>
      {subtitle && <div style={{ fontSize: 12, color: "var(--orvyn-text-muted)", marginBottom: 16 }}>{subtitle}</div>}
      {children}
    </div>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        background: "var(--orvyn-surface-2)",
        border: "1px solid var(--orvyn-border-soft)",
        borderRadius: "var(--orvyn-radius-md)",
        padding: "8px 14px",
        marginBottom: 10,
      }}
    >
      {children}
    </div>
  );
}

interface ServerRow {
  alias: string;
  host: string;
  user: string;
  port: number;
}

export function ServersWorkspace({ projectRoot }: { projectRoot: string | null }) {
  const [servers, setServers] = useState<ServerRow[]>([]);
  const [checks, setChecks] = useState<Record<string, { busy: boolean; ok?: boolean; output?: string }>>({});

  const load = useCallback(async () => {
    if (!projectRoot) return setServers([]);
    try {
      const data = await fetch(apiUrl(`/servers?projectRoot=${encodeURIComponent(projectRoot)}`), {
        headers: authHeaders(),
      }).then((r) => r.json());
      setServers(data.servers ?? []);
    } catch {
      setServers([]);
    }
  }, [projectRoot]);

  useEffect(() => {
    void load();
  }, [load]);

  async function healthCheck(alias: string) {
    setChecks((c) => ({ ...c, [alias]: { busy: true } }));
    try {
      // Real execution through the tool route. ssh_exec is permission "ask";
      // the user pressing this button IS the approval, same as the agent UI.
      const res = await fetch(apiUrl("/tools/ssh_exec/execute"), {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ args: { host: alias, command: "uptime && echo OK" }, approved: true }),
      });
      const data = await res.json();
      setChecks((c) => ({
        ...c,
        [alias]: { busy: false, ok: data.ok === true, output: String(data.output ?? data.error ?? "").slice(0, 200) },
      }));
    } catch (err: any) {
      setChecks((c) => ({ ...c, [alias]: { busy: false, ok: false, output: err.message } }));
    }
  }

  return (
    <Shell title="Servers" subtitle="SSH connections from this project's .orvyn/ssh.json — the same allowlist the agent uses.">
      {servers.length === 0 ? (
        <HonestState
          title="NO SERVERS CONNECTED"
          message={'Add a host to .orvyn/ssh.json in the project root — {"hosts":[{"alias":"prod","host":"1.2.3.4","user":"ubuntu","keyPath":"~/.ssh/id_ed25519"}]} — and it appears here. The agent can then SSH in with your approval.'}
        />
      ) : (
        servers.map((s) => {
          const check = checks[s.alias];
          return (
            <Card key={s.alias}>
              <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "4px 0" }}>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontSize: 13.5, fontWeight: 600 }}>{s.alias}</div>
                  <div style={{ fontSize: 11.5, color: "var(--orvyn-text-muted)" }}>
                    {s.user}@{s.host}:{s.port}
                  </div>
                  {check?.output && (
                    <div style={{ fontSize: 11, color: check.ok ? "var(--orvyn-green)" : "var(--orvyn-red)", fontFamily: "var(--font-mono)", marginTop: 4, whiteSpace: "pre-wrap" }}>
                      {check.output}
                    </div>
                  )}
                </div>
                <span style={{ fontSize: 11, color: check ? (check.ok ? "var(--orvyn-green)" : "var(--orvyn-red)") : "var(--orvyn-text-muted)", flexShrink: 0 }}>
                  {check ? (check.busy ? "checking…" : check.ok ? "ONLINE" : "FAILED") : "CONFIGURED"}
                </span>
                <button
                  onClick={() => void healthCheck(s.alias)}
                  disabled={check?.busy}
                  style={{
                    background: "transparent",
                    border: "1px solid var(--orvyn-border)",
                    borderRadius: 6,
                    color: "var(--orvyn-text-secondary)",
                    padding: "5px 12px",
                    fontSize: 11.5,
                    cursor: "pointer",
                    flexShrink: 0,
                  }}
                >
                  Health Check
                </button>
              </div>
            </Card>
          );
        })
      )}
    </Shell>
  );
}

export function ToolsWorkspace({ projectRoot }: { projectRoot: string | null }) {
  const [tools, setTools] = useState<{ name: string; description: string; permission: string; capabilities: string[] }[]>([]);

  useEffect(() => {
    const root = projectRoot ? `?projectRoot=${encodeURIComponent(projectRoot)}` : "";
    fetch(apiUrl(`/tools${root}`), { headers: authHeaders() })
      .then((r) => r.json())
      .then((d) => setTools(d.tools ?? []))
      .catch(() => setTools([]));
  }, [projectRoot]);

  return (
    <Shell title="Tools & MCP" subtitle="Built-in document, file, terminal, web and browser tools. MCP connects additional services configured for this project.">
      {tools.length === 0 ? (
        <HonestState title="NO TOOLS REGISTERED" message="Open a project folder — tools register per project." />
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 8 }}>
          {tools.map((t) => (
            <div
              key={t.name}
              style={{
                background: "var(--orvyn-surface-2)",
                border: "1px solid var(--orvyn-border-soft)",
                borderRadius: "var(--orvyn-radius-md)",
                padding: "9px 12px",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <code style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}>{t.name.replace(/_/g," ")}</code>
                <span
                  style={{
                    marginLeft: "auto",
                    fontSize: 10,
                    fontWeight: 700,
                    letterSpacing: 0.5,
                    color:
                      t.permission === "allowed" ? "var(--orvyn-green)" : t.permission === "denied" ? "var(--orvyn-red)" : "var(--orvyn-yellow)",
                    border: "1px solid currentColor",
                    borderRadius: 4,
                    padding: "0 6px",
                  }}
                >
                  {t.permission.toUpperCase()}
                </span>
              </div>
              <div style={{ fontSize: 11, color: "var(--orvyn-text-muted)", marginTop: 4, lineHeight: 1.4 }}>
                {t.description}
              </div>
            </div>
          ))}
        </div>
      )}
    </Shell>
  );
}

export function AgentsWorkspace() {
  const [agents, setAgents] = useState<{ role: string; label: string; status: string; modelId: string | null }[]>([]);

  useEffect(() => {
    const load = () =>
      fetch(apiUrl("/agents"), { headers: authHeaders() })
        .then((r) => r.json())
        .then((d) => setAgents(d.agents ?? []))
        .catch(() => setAgents([]));
    void load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, []);

  return (
    <Shell title="Agents" subtitle="The live roster and the model each role routes to.">
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 8 }}>
        {agents.map((a) => (
          <div
            key={a.role}
            style={{
              background: "var(--orvyn-surface-2)",
              border: "1px solid var(--orvyn-border-soft)",
              borderRadius: "var(--orvyn-radius-md)",
              padding: "10px 12px",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
              <span style={{ width: 7, height: 7, borderRadius: "50%", background: a.modelId ? "var(--orvyn-green)" : "var(--orvyn-yellow)" }} />
              <span style={{ fontSize: 13, fontWeight: 600 }}>{a.label}</span>
            </div>
            <div style={{ fontSize: 11, color: "var(--orvyn-text-muted)", marginTop: 4, fontFamily: "var(--font-mono)" }}>
              {a.modelId ?? "no model routed"}
            </div>
          </div>
        ))}
      </div>
    </Shell>
  );
}

export function ProjectsWorkspace({ onOpenFolder }: { onOpenFolder: () => void }) {
  return (
    <Shell title="Projects" subtitle="Open a local project — ORVYN indexes it and the agents work against it.">
      <HonestState
        title="OPEN A PROJECT TO BEGIN"
        message="Recent-project history and Git/clone flows arrive with the Projects service. Today: open a local folder and every workspace (Code, Servers, Missions) binds to it."
        actionLabel="Open Folder…"
        onAction={onOpenFolder}
      />
    </Shell>
  );
}
