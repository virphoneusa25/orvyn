// apps/desktop/src/renderer/components/ToolsMcpWorkspace.tsx
//
// Tools & MCP page: two sections per the approved layout —
//   BUILT-IN TOOLS  (ORVYN native tools: status, permission, capabilities)
//   MCP SERVERS     (cards with truthful connection state, tool counts,
//                    actions: Connect/Disconnect/Reconnect/Remove, per-tool
//                    permissions, and an Add MCP Server flow with Test
//                    Connection).
// Truth rule: states come from /mcp/statuses — nothing is ever hardcoded
// green.

import React, { useCallback, useEffect, useState } from "react";
import { apiUrl, authHeaders } from "../connection";
import { fetchInstalledMcpStatuses } from "../mcpPublicInstall";
import { McpMarketplace } from "./McpMarketplace";

interface NativeTool {
  name: string;
  description: string;
  permission: string;
  capabilities?: string[];
}

interface McpToolRow {
  name: string;
  risk: string;
  permission: "ALLOW" | "ASK" | "DENY";
  description: string;
}

interface McpServerStatus {
  id: string;
  name: string;
  transport: "stdio" | "http";
  state: "DISCONNECTED" | "CONNECTING" | "CONNECTED" | "ERROR" | "DISABLED" | "NEEDS_AUTH";
  toolCount: number;
  resourceCount: number;
  promptCount: number;
  lastConnectedAt?: number;
  lastError?: string;
  enabled: boolean;
  tools: McpToolRow[];
  executionLocation?: "local" | "cloud" | "remote";
  scope?: "global" | "project" | "run";
  authKind?: string;
  blocked?: boolean;
  blockedReason?: string;
}

interface HealthRow {
  serverId: string;
  status: "Healthy" | "Slow" | "Needs Auth" | "Offline" | "Error" | "Disabled" | "Blocked";
  latencyMs?: number;
  circuitReason?: string;
  restartCount?: number;
}

const STATE_COLOR: Record<string, string> = {
  CONNECTED: "var(--orvyn-green, #20D89B)",
  CONNECTING: "var(--orvyn-yellow, #F5B942)",
  DISCONNECTED: "var(--orvyn-text-muted, #7A8298)",
  ERROR: "var(--orvyn-red, #F25F75)",
  DISABLED: "var(--orvyn-text-muted, #7A8298)",
  NEEDS_AUTH: "var(--orvyn-yellow, #F5B942)",
  Healthy: "var(--orvyn-green, #20D89B)",
  Slow: "var(--orvyn-yellow, #F5B942)",
  "Needs Auth": "var(--orvyn-yellow, #F5B942)",
  Offline: "var(--orvyn-text-muted, #7A8298)",
  Error: "var(--orvyn-red, #F25F75)",
  Disabled: "var(--orvyn-text-muted, #7A8298)",
  Blocked: "var(--orvyn-red, #F25F75)",
};

const SCOPE_HELP: Record<string, string> = {
  global: "Available to every project for this account (for example a GitHub login).",
  project: "Only this project can discover or invoke this server (for example a project database).",
  run: "Ephemeral — active for the current ORION run and deactivated when the run ends.",
};

function relTime(ts?: number): string {
  if (!ts) return "never";
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function ToolsMcpWorkspace({ projectRoot }: { projectRoot: string | null }) {
  const [page, setPage] = useState<"marketplace" | "installed" | "builtin">("marketplace");
  const [marketQuery, setMarketQuery] = useState("");
  const [capabilityBanner, setCapabilityBanner] = useState("");
  const [native, setNative] = useState<NativeTool[]>([]);
  const [servers, setServers] = useState<McpServerStatus[]>([]);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [health, setHealth] = useState<Record<string, HealthRow>>({});

  const refresh = useCallback(async () => {
    try {
      const root = projectRoot ? `?projectRoot=${encodeURIComponent(projectRoot)}` : "";
      const headers = authHeaders();
      const [t, s, h] = await Promise.all([
        fetch(apiUrl(`/tools${root}`), { headers }).then((r) => r.json()).catch(() => ({ tools: [] })),
        fetchInstalledMcpStatuses().then((servers) => ({ servers })).catch(() => ({ servers: [] })),
        fetch(apiUrl("/mcp/health"), { headers }).then((r) => r.json()).catch(() => ({ servers: [] })),
      ]);
      setNative(t.tools ?? []);
      setServers(s.servers ?? []);
      const map: Record<string, HealthRow> = {};
      for (const row of h.servers ?? []) map[row.serverId] = row;
      setHealth(map);
    } catch {
      /* keep last known */
    }
  }, [projectRoot]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(refresh, 5000);
    return () => clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    const open = (e: Event) => {
      const q = (e as CustomEvent<{ query?: string; reason?: string }>).detail?.query ?? "";
      const reason = (e as CustomEvent<{ query?: string; reason?: string }>).detail?.reason ?? "";
      setPage("marketplace");
      setMarketQuery(q);
      setCapabilityBanner(reason || (q ? `ORION needs ${q}.` : ""));
    };
    const add = () => {
      setPage("installed");
      setAdding(true);
    };
    document.addEventListener("orvyn:marketplace-open", open as EventListener);
    document.addEventListener("orvyn:mcp-add-server", add);
    return () => {
      document.removeEventListener("orvyn:marketplace-open", open as EventListener);
      document.removeEventListener("orvyn:mcp-add-server", add);
    };
  }, []);

  async function serverAction(id: string, action: "connect" | "disconnect" | "reconnect") {
    setBusy(id);
    try {
      await fetch(apiUrl(`/mcp/servers/${id}/${action}`), { method: "POST", headers: { "Content-Type": "application/json", ...authHeaders() } });
    } finally {
      setBusy(null);
      void refresh();
    }
  }

  async function removeServer(id: string) {
    setBusy(id);
    try {
      await fetch(apiUrl(`/mcp/servers/${id}`), { method: "DELETE", headers: authHeaders() });
    } finally {
      setBusy(null);
      void refresh();
    }
  }

  async function setScope(id: string, scope: "global" | "project" | "run") {
    await fetch(apiUrl(`/mcp/servers/${id}/scope`), {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ scope, cwd: projectRoot }),
    });
    void refresh();
  }

  async function connectAccount(id: string) {
    setBusy(id);
    try {
      const res = await fetch(apiUrl("/mcp/oauth/start"), {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ serverId: id }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "OAuth start failed");
      if (data.authorizeUrl && window.orvyn?.window?.openExternal) {
        await window.orvyn.window.openExternal(data.authorizeUrl);
      } else if (data.authorizeUrl) {
        window.open(data.authorizeUrl, "_blank", "noopener");
      }
    } finally {
      setBusy(null);
      void refresh();
    }
  }

  async function disconnectAccount(id: string) {
    setBusy(id);
    try {
      await fetch(apiUrl(`/mcp/oauth/disconnect/${id}`), { method: "POST", headers: { "Content-Type": "application/json", ...authHeaders() } });
    } finally {
      setBusy(null);
      void refresh();
    }
  }

  async function setToolPermission(serverId: string, tool: string, mode: "ALLOW" | "ASK" | "DENY") {
    await fetch(apiUrl(`/mcp/servers/${serverId}/permissions/tool`), {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ tool, mode }),
    });
    void refresh();
  }

  return (
    <div data-testid="tools-mcp-workspace" style={{ height: "100%", width: "100%", display: "flex", flexDirection: "column", minWidth: 0, minHeight: 0, background: "var(--orvyn-bg, #0B0E14)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", padding: "10px 16px", flexShrink: 0, borderBottom: "1px solid var(--orvyn-border-soft)" }}>
        {([
          ["marketplace", "Marketplace"],
          ["installed", "Installed"],
          ["builtin", "Built-in tools"],
        ] as const).map(([id, label]) => (
          <button
            key={id}
            onClick={() => setPage(id)}
            style={{
              background: page === id ? "rgba(85,99,245,0.18)" : "transparent",
              border: `1px solid ${page === id ? "var(--orvyn-purple, #5563F5)" : "var(--orvyn-border)"}`,
              borderRadius: 8,
              color: page === id ? "var(--orvyn-text)" : "var(--orvyn-text-muted)",
              fontSize: 12,
              padding: "6px 12px",
              cursor: "pointer",
            }}
          >
            {label}
          </button>
        ))}
      </div>

      {page === "marketplace" && (
        <div style={{ flex: 1, minHeight: 0, minWidth: 0, overflow: "hidden" }}>
          <McpMarketplace
            projectRoot={projectRoot}
            initialQuery={marketQuery}
            capabilityBanner={capabilityBanner}
            onInstalled={() => {
              void refresh();
              setPage("installed");
            }}
          />
        </div>
      )}

      {page === "builtin" && (
        <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "16px 20px" }}>
        <>
      <h2 style={{ fontSize: 13, letterSpacing: 1.2, color: "var(--orvyn-text-muted)", margin: "0 0 10px" }}>BUILT-IN TOOLS</h2>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: 10, marginBottom: 28 }}>
        {native.map((t) => (
          <div key={t.name} style={{ background: "var(--orvyn-surface-2, #121724)", border: "1px solid var(--orvyn-border-soft)", borderRadius: 10, padding: "10px 12px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 12.5, fontWeight: 600, fontFamily: "var(--font-mono)", color: "var(--orvyn-text)" }}>{t.name}</span>
              <span
                style={{
                  marginLeft: "auto",
                  fontSize: 9.5,
                  fontWeight: 700,
                  letterSpacing: 0.5,
                  color: t.permission === "allowed" ? "var(--orvyn-green, #20D89B)" : t.permission === "denied" ? "var(--orvyn-red, #F25F75)" : "var(--orvyn-yellow, #F5B942)",
                  border: "1px solid currentColor",
                  borderRadius: 4,
                  padding: "1px 6px",
                }}
              >
                {t.permission.toUpperCase()}
              </span>
            </div>
            <div style={{ fontSize: 11, color: "var(--orvyn-text-muted)", marginTop: 4, lineHeight: 1.4 }}>{t.description?.slice(0, 120) || "—"}</div>
          </div>
        ))}
        {native.length === 0 && <div style={{ fontSize: 12, color: "var(--orvyn-text-muted)" }}>No native tools registered.</div>}
      </div>
        </>
        </div>
      )}

      {page === "installed" && (
        <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "16px 20px" }}>
        <>
      {/* ── MCP SERVERS ────────────────────────────────────────────── */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 10 }}>
        <h2 style={{ fontSize: 13, letterSpacing: 1.2, color: "var(--orvyn-text-muted)", margin: 0 }}>MCP SERVERS</h2>
        <button
          onClick={() => setAdding(true)}
          style={{
            marginLeft: "auto",
            background: "var(--orvyn-purple, #5563F5)",
            border: "none",
            borderRadius: 7,
            color: "#fff",
            fontSize: 12,
            fontWeight: 600,
            padding: "6px 14px",
            cursor: "pointer",
          }}
        >
          + Add MCP Server
        </button>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {servers.map((s) => {
          const h = health[s.id];
          const label = s.blocked ? "Blocked" : h?.status ?? (s.state === "NEEDS_AUTH" ? "Needs Auth" : s.state);
          const location = s.executionLocation ?? (s.transport === "http" ? "remote" : "local");
          return (
          <div key={s.id} style={{ background: "var(--orvyn-surface-2, #121724)", border: "1px solid var(--orvyn-border-soft)", borderRadius: 10, padding: "12px 14px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <span style={{ width: 8, height: 8, borderRadius: "50%", background: STATE_COLOR[label] ?? STATE_COLOR[s.state], flexShrink: 0 }} />
              <span style={{ fontSize: 13, fontWeight: 600, color: "var(--orvyn-text)" }}>{s.name}</span>
              <span style={{ fontSize: 10, color: "var(--orvyn-text-muted)", fontFamily: "var(--font-mono)" }}>
                {label} · {s.transport.toUpperCase()} · {location === "local" ? "Local Only" : location} · {s.toolCount} tools{s.resourceCount ? ` · ${s.resourceCount} resources` : ""}
                {h?.latencyMs != null ? ` · ${Math.round(h.latencyMs)}ms` : ""}
              </span>
              <span style={{ fontSize: 10, color: "var(--orvyn-text-muted)" }}>connected {relTime(s.lastConnectedAt)}</span>
              <span style={{ marginLeft: "auto", display: "flex", gap: 6, flexWrap: "wrap" }}>
                {(s.authKind === "oauth" || s.state === "NEEDS_AUTH") && (
                  s.state === "CONNECTED"
                    ? <SmallBtn label="Disconnect account" onClick={() => void disconnectAccount(s.id)} />
                    : <SmallBtn label={busy === s.id ? "…" : "Connect account"} onClick={() => void connectAccount(s.id)} />
                )}
                {s.state === "CONNECTED" ? (
                  <>
                    <SmallBtn label={busy === s.id ? "…" : "Reconnect"} onClick={() => void serverAction(s.id, "reconnect")} />
                    <SmallBtn label="Disconnect" onClick={() => void serverAction(s.id, "disconnect")} />
                  </>
                ) : !s.blocked && s.state !== "NEEDS_AUTH" ? (
                  <SmallBtn label={busy === s.id ? "…" : "Connect"} onClick={() => void serverAction(s.id, "connect")} />
                ) : null}
                <SmallBtn label="Remove" danger onClick={() => void removeServer(s.id)} />
              </span>
            </div>
            <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 8, flexWrap: "wrap" }}>
              <span style={{ fontSize: 10.5, color: "var(--orvyn-text-muted)" }}>Scope</span>
              <select
                value={s.scope ?? "global"}
                onChange={(e) => void setScope(s.id, e.target.value as "global" | "project" | "run")}
                style={{ background: "transparent", border: "1px solid var(--orvyn-border)", borderRadius: 4, color: "var(--orvyn-text-secondary)", fontSize: 10, padding: "1px 4px" }}
              >
                <option value="global">Global</option>
                <option value="project">This Project</option>
                <option value="run">This Run</option>
              </select>
              <span style={{ fontSize: 10.5, color: "var(--orvyn-text-muted)", maxWidth: 420 }}>{SCOPE_HELP[s.scope ?? "global"]}</span>
            </div>
            {s.blocked && <div style={{ fontSize: 11, color: "var(--orvyn-red, #F25F75)", marginTop: 6 }}>Blocked: {s.blockedReason || "policy"}</div>}
            {h?.circuitReason && <div style={{ fontSize: 11, color: "var(--orvyn-yellow, #F5B942)", marginTop: 6 }}>Circuit open: {h.circuitReason}</div>}
            {s.lastError && <div style={{ fontSize: 11, color: "var(--orvyn-red, #F25F75)", marginTop: 6 }}>{s.lastError}</div>}
            {s.tools.length > 0 && (
              <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 4 }}>
                {s.tools.map((t) => (
                  <div key={t.name} style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 11.5 }}>
                    <code style={{ fontFamily: "var(--font-mono)", color: "var(--orvyn-text-secondary, #A0A7BB)", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>
                      {t.name}
                    </code>
                    <span style={{ fontSize: 9.5, color: t.risk === "READ" ? "var(--orvyn-cyan, #22D3EE)" : t.risk === "DESTRUCTIVE" ? "var(--orvyn-red, #F25F75)" : "var(--orvyn-yellow, #F5B942)" }}>{t.risk}</span>
                    <select
                      value={t.permission}
                      onChange={(e) => void setToolPermission(s.id, t.name, e.target.value as "ALLOW" | "ASK" | "DENY")}
                      style={{ background: "transparent", border: "1px solid var(--orvyn-border)", borderRadius: 4, color: "var(--orvyn-text-secondary)", fontSize: 10, padding: "1px 4px" }}
                    >
                      <option value="ALLOW">Allow</option>
                      <option value="ASK">Ask</option>
                      <option value="DENY">Deny</option>
                    </select>
                  </div>
                ))}
              </div>
            )}
          </div>
          );
        })}
        {servers.length === 0 && (
          <div style={{ fontSize: 12, color: "var(--orvyn-text-muted)", padding: "18px 0" }}>
            No MCP servers installed yet. Open Marketplace, search for an official tool, then click Search and Install.
          </div>
        )}
      </div>

      {adding && <AddServerDialog onClose={() => setAdding(false)} onDone={() => { setAdding(false); void refresh(); }} />}
        </>
        </div>
      )}
    </div>
  );
}

function SmallBtn({ label, onClick, danger }: { label: string; onClick: () => void; danger?: boolean }) {
  return (
    <button
      onClick={onClick}
      style={{
        background: "transparent",
        border: `1px solid ${danger ? "var(--orvyn-red, #F25F75)" : "var(--orvyn-border)"}`,
        borderRadius: 6,
        color: danger ? "var(--orvyn-red, #F25F75)" : "var(--orvyn-text-secondary)",
        fontSize: 10.5,
        padding: "3px 10px",
        cursor: "pointer",
      }}
    >
      {label}
    </button>
  );
}

function AddServerDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState("");
  const [transport, setTransport] = useState<"stdio" | "http">("stdio");
  const [command, setCommand] = useState("npx");
  const [args, setArgs] = useState("");
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [tested, setTested] = useState(false);
  const [toolCount, setToolCount] = useState(0);

  async function test() {
    setTesting(true);
    setResult(null);
    try {
      const res = await fetch(apiUrl("/mcp/test"), {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({
          name: name || "test-server",
          transport,
          command: transport === "stdio" ? command : undefined,
          args: transport === "stdio" ? (args ? args.split(/\s+/) : []) : undefined,
          url: transport === "http" ? url : undefined,
          headers: transport === "http" && token ? { Authorization: `Bearer ${token}` } : undefined,
          secrets: token ? { token } : undefined,
        }),
      });
      const data = await res.json();
      if (data.ok) {
        setTested(true);
        setToolCount(data.status?.toolCount ?? 0);
        setResult(`Connected — ${data.status?.toolCount ?? 0} tools discovered${data.status?.resourceCount ? `, ${data.status.resourceCount} resources` : ""}.`);
      } else {
        setResult(`Connection failed: ${data.status?.lastError ?? data.error ?? "unknown error"}`);
      }
    } catch (err: any) {
      setResult(`Connection failed: ${err.message}`);
    } finally {
      setTesting(false);
    }
  }

  async function save() {
    try {
      const create = await fetch(apiUrl("/mcp/servers"), {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({
          name: name || "mcp-server",
          transport,
          command: transport === "stdio" ? command : undefined,
          args: transport === "stdio" ? (args ? args.split(/\s+/) : []) : undefined,
          url: transport === "http" ? url : undefined,
          headers: transport === "http" && token ? { Authorization: "Bearer {{token}}" } : undefined,
          secrets: token ? { token } : undefined,
        }),
      });
      const created = await create.json();
      if (created.server?.id) {
        await fetch(apiUrl(`/mcp/servers/${created.server.id}/connect`), { method: "POST", headers: { "Content-Type": "application/json", ...authHeaders() } });
      }
    } finally {
      onDone();
    }
  }

  const input: React.CSSProperties = {
    width: "100%",
    background: "var(--orvyn-bg, #0B0E14)",
    border: "1px solid var(--orvyn-border)",
    borderRadius: 7,
    color: "var(--orvyn-text)",
    fontSize: 12.5,
    padding: "7px 10px",
    marginBottom: 10,
    outline: "none",
  };

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 }} onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ width: 440, background: "var(--orvyn-surface-2, #121724)", border: "1px solid var(--orvyn-border)", borderRadius: 12, padding: 20 }}
      >
        <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 14 }}>Add MCP Server</div>
        <div style={{ fontSize: 11, color: "var(--orvyn-text-muted)", marginBottom: 4 }}>Name</div>
        <input style={input} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. github" />
        <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
          {(["stdio", "http"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTransport(t)}
              style={{
                flex: 1,
                background: transport === t ? "var(--orvyn-purple, #5563F5)" : "transparent",
                border: `1px solid ${transport === t ? "var(--orvyn-purple, #5563F5)" : "var(--orvyn-border)"}`,
                borderRadius: 7,
                color: transport === t ? "#fff" : "var(--orvyn-text-secondary)",
                fontSize: 12,
                padding: "6px 0",
                cursor: "pointer",
              }}
            >
              {t === "stdio" ? "Local stdio" : "Remote HTTP"}
            </button>
          ))}
        </div>
        {transport === "stdio" ? (
          <>
            <div style={{ fontSize: 11, color: "var(--orvyn-text-muted)", marginBottom: 4 }}>Command</div>
            <input style={input} value={command} onChange={(e) => setCommand(e.target.value)} placeholder="npx" />
            <div style={{ fontSize: 11, color: "var(--orvyn-text-muted)", marginBottom: 4 }}>Arguments (space-separated)</div>
            <input style={input} value={args} onChange={(e) => setArgs(e.target.value)} placeholder="-y @modelcontextprotocol/server-github" />
          </>
        ) : (
          <>
            <div style={{ fontSize: 11, color: "var(--orvyn-text-muted)", marginBottom: 4 }}>URL</div>
            <input style={input} value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://mcp.example.com/mcp" />
            <div style={{ fontSize: 11, color: "var(--orvyn-text-muted)", marginBottom: 4 }}>Bearer token (stored securely, never shown again)</div>
            <input style={input} type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="optional" />
          </>
        )}
        {result && (
          <div style={{ fontSize: 11.5, color: tested ? "var(--orvyn-green, #20D89B)" : "var(--orvyn-red, #F25F75)", marginBottom: 10, fontFamily: "var(--font-mono)" }}>{result}</div>
        )}
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={() => void test()} disabled={testing} style={{ flex: 1, background: "transparent", border: "1px solid var(--orvyn-border)", borderRadius: 7, color: "var(--orvyn-text-secondary)", fontSize: 12, padding: "8px 0", cursor: "pointer" }}>
            {testing ? "Testing…" : "Test Connection"}
          </button>
          <button onClick={onClose} style={{ flex: 1, background: "transparent", border: "1px solid var(--orvyn-border)", borderRadius: 7, color: "var(--orvyn-text-muted)", fontSize: 12, padding: "8px 0", cursor: "pointer" }}>
            Cancel
          </button>
          <button onClick={() => void save()} disabled={!tested} style={{ flex: 1, background: tested ? "var(--orvyn-purple, #5563F5)" : "var(--orvyn-border)", border: "none", borderRadius: 7, color: "#fff", fontSize: 12, fontWeight: 600, padding: "8px 0", cursor: tested ? "pointer" : "default", opacity: tested ? 1 : 0.5 }}>
            Save Server
          </button>
        </div>
        {!tested && <div style={{ fontSize: 10.5, color: "var(--orvyn-text-muted)", marginTop: 8 }}>Test the connection first — a server saves only after a successful test.</div>}
      </div>
    </div>
  );
}
