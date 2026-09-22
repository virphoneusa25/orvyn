// MCP Marketplace — discover, inspect, install, connect. Talks to
// /mcp/marketplace/* and installs into the existing McpManager.
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { apiUrl, authHeaders } from "../connection";

type Source = "official" | "glama" | "local" | "private";

interface MarketServer {
  canonicalId: string;
  name: string;
  title?: string;
  description: string;
  publisher?: string;
  sources: Source[];
  repository?: string;
  categories: string[];
  transports: { kind: "stdio" | "http"; command?: string; args?: string[]; url?: string }[];
  tools?: { name: string; description: string; risk: string }[];
  auth: { kind: string; label: string }[];
  trust: { level: string; reasons: string[] };
  installed?: { serverId: string; enabled: boolean; state: string };
  compatibility: string;
  compatibilityReason?: string;
  toolCount?: number;
  version?: string;
  networkRequired: boolean;
  qualityNote?: string;
}

interface Health {
  id: string;
  name: string;
  status: string;
  detail?: string;
}

const SOURCE_LABEL: Record<Source, string> = {
  official: "Official",
  glama: "Glama",
  local: "Local",
  private: "Private",
};

export function McpMarketplace({
  projectRoot,
  initialQuery = "",
  onInstalled,
}: {
  projectRoot: string | null;
  initialQuery?: string;
  onInstalled?: () => void;
}) {
  const [q, setQ] = useState(initialQuery);
  const [debounced, setDebounced] = useState(initialQuery);
  const [tab, setTab] = useState<"discover" | "installed" | "updates" | "private">("discover");
  const [results, setResults] = useState<MarketServer[]>([]);
  const [health, setHealth] = useState<Health[]>([]);
  const [degraded, setDegraded] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<MarketServer | null>(null);
  const [filter, setFilter] = useState<string>("all");
  const [category, setCategory] = useState<string>("");
  const [categories, setCategories] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [updates, setUpdates] = useState<{ serverId: string; name: string; current: string; changelog: string }[]>([]);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 280);
    return () => clearTimeout(t);
  }, [q]);

  const search = useCallback(async (query: string) => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (query) params.set("q", query);
      params.set("limit", "24");
      if (category) params.set("category", category);
      const [searchRes, healthRes] = await Promise.all([
        fetch(apiUrl(`/mcp/marketplace/search?${params}`), { headers: authHeaders() }),
        fetch(apiUrl("/mcp/marketplace/health"), { headers: authHeaders() }),
      ]);
      const data = await searchRes.json();
      const healthBody = await healthRes.json().catch(() => ({}));
      if (!searchRes.ok) throw new Error(data.error || `HTTP ${searchRes.status}`);
      setResults(data.results?.map((r: any) => r.server) ?? []);
      setHealth(data.health ?? healthBody.providers ?? []);
      setDegraded(data.degraded ?? []);
    } catch (err: any) {
      setError(err.message);
      setResults([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void search(debounced);
  }, [debounced, search, category]);

  useEffect(() => {
    fetch(apiUrl("/mcp/marketplace/categories"), { headers: authHeaders() })
      .then((r) => r.json())
      .then((d) => setCategories(d.categories ?? []))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (tab !== "updates") return;
    fetch(apiUrl("/mcp/marketplace/updates"), { headers: authHeaders() })
      .then((r) => r.json())
      .then((d) => setUpdates(d.updates ?? []))
      .catch(() => setUpdates([]));
  }, [tab]);

  const featured = useMemo(() => {
    if (debounced) return results;
    return results.slice(0, 8);
  }, [results, debounced]);

  const visible = featured.filter((s) => {
    if (filter === "official") return s.sources.includes("official");
    if (filter === "verified") return s.trust.level === "verified" || s.trust.level === "community";
    if (filter === "installed") return Boolean(s.installed);
    if (filter === "remote") return s.transports.some((t) => t.kind === "http");
    if (filter === "local") return s.transports.some((t) => t.kind === "stdio");
    return true;
  });

  async function install(server: MarketServer, secrets?: Record<string, string>) {
    setBusy(true);
    try {
      const res = await fetch(apiUrl("/mcp/marketplace/install"), {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ server, secrets, connect: true, cwd: projectRoot }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Install failed");
      onInstalled?.();
      setSelected(null);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div style={{ marginBottom: 18 }}>
        <div style={{ fontSize: 22, fontWeight: 600, letterSpacing: "-0.02em" }}>MCP Marketplace</div>
        <div style={{ fontSize: 13, color: "var(--orvyn-text-muted)", marginTop: 4 }}>
          Extend ORION with tools, services, and integrations. Catalogs stay out of the model context.
        </div>
      </div>

      <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        {(["discover", "installed", "updates", "private"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            style={tabBtn(tab === t)}
          >
            {t === "discover" ? "Discover" : t === "installed" ? "Installed" : t === "updates" ? "Updates" : "Private"}
          </button>
        ))}
      </div>

      {tab === "private" ? (
        <PrivateRegistries onSaved={() => void search(debounced)} />
      ) : tab === "updates" ? (
        <UpdatesList updates={updates} />
      ) : (
        <>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search MCP servers, connectors, and tools…"
            style={searchInput}
          />
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", margin: "10px 0 14px" }}>
            {["all", "official", "verified", "installed", "remote", "local"].map((f) => (
              <button key={f} onClick={() => setFilter(f)} style={chip(filter === f)}>
                {f[0].toUpperCase() + f.slice(1)}
              </button>
            ))}
            {categories.slice(0, 10).map((c) => (
              <button key={c} onClick={() => setCategory(category === c ? "" : c)} style={chip(category === c)}>
                {c}
              </button>
            ))}
          </div>
          <ProviderPills health={health} />
          {degraded.length > 0 && (
            <div style={{ fontSize: 11, color: "var(--orvyn-yellow, #E9B44C)", marginBottom: 10 }}>{degraded.join(" · ")}</div>
          )}
          {error && <div style={{ fontSize: 12, color: "var(--orvyn-red, #F25F75)", marginBottom: 10 }}>{error}</div>}
          {loading && <div style={{ fontSize: 12, color: "var(--orvyn-text-muted)", padding: "20px 0" }}>Searching registries…</div>}
          {!loading && visible.length === 0 && (
            <div style={{ fontSize: 13, color: "var(--orvyn-text-muted)", padding: "28px 0" }}>
              {debounced
                ? `No servers matched “${debounced}”. Official Registry is a name search — try GitHub, Postgres, Slack, or a package name.`
                : "Search to federate the Official MCP Registry (and Glama when a key is configured). Installed servers always appear."}
            </div>
          )}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 12 }}>
            {visible.map((s) => (
              <ServerCard key={s.canonicalId} server={s} onView={() => setSelected(s)} onInstall={() => void install(s)} busy={busy} />
            ))}
          </div>
        </>
      )}

      {selected && (
        <DetailDrawer
          server={selected}
          busy={busy}
          onClose={() => setSelected(null)}
          onInstall={(secrets) => void install(selected, secrets)}
        />
      )}
    </div>
  );
}

function ServerCard({ server, onView, onInstall, busy }: { server: MarketServer; onView: () => void; onInstall: () => void; busy: boolean }) {
  const label = server.title || server.name.split("/").pop() || server.name;
  return (
    <div style={card}>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 6 }}>
        {server.sources.map((s) => (
          <span key={s} style={badge}>{SOURCE_LABEL[s]}</span>
        ))}
        <span style={badge}>{server.trust.level}</span>
        {server.installed && <span style={{ ...badge, color: "var(--orvyn-green, #86D69A)" }}>Installed</span>}
      </div>
      <div style={{ fontSize: 14, fontWeight: 600 }}>{label}</div>
      <div style={{ fontSize: 11, color: "var(--orvyn-text-muted)", margin: "2px 0 8px" }}>{server.publisher ?? server.name}</div>
      <div style={{ fontSize: 12, color: "var(--orvyn-text-secondary)", lineHeight: 1.45, minHeight: 38 }}>
        {server.description.slice(0, 140)}
      </div>
      <div style={{ fontSize: 10.5, color: "var(--orvyn-text-muted)", margin: "10px 0 12px", fontFamily: "var(--font-mono)" }}>
        {server.transports.map((t) => t.kind).join(" · ") || "transport unknown"}
        {server.toolCount != null ? ` · ${server.toolCount} tools` : ""}
        {server.networkRequired ? " · network" : ""}
        {` · ${server.compatibility}`}
      </div>
      <div style={{ display: "flex", gap: 6 }}>
        <button onClick={onView} style={ghostBtn}>View</button>
        <button onClick={onInstall} disabled={busy || Boolean(server.installed)} style={primaryBtn}>
          {server.installed ? "Installed" : server.transports.some((t) => t.kind === "http") ? "Connect" : "Install"}
        </button>
      </div>
    </div>
  );
}

function DetailDrawer({
  server,
  onClose,
  onInstall,
  busy,
}: {
  server: MarketServer;
  onClose: () => void;
  onInstall: (secrets?: Record<string, string>) => void;
  busy: boolean;
}) {
  const [step, setStep] = useState(0);
  const [token, setToken] = useState("");
  const label = server.title || server.name.split("/").pop() || server.name;
  const steps = ["Review", "Permissions", "Authentication", "Install", "Done"];
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", zIndex: 80, display: "flex", justifyContent: "flex-end" }} onClick={onClose}>
      <aside
        onClick={(e) => e.stopPropagation()}
        style={{ width: "min(480px, 100%)", height: "100%", background: "var(--orvyn-surface-2, #121724)", borderLeft: "1px solid var(--orvyn-border)", padding: 22, overflowY: "auto" }}
      >
        <div style={{ fontSize: 11, color: "var(--orvyn-text-muted)", marginBottom: 8 }}>{steps[step]}</div>
        <div style={{ fontSize: 18, fontWeight: 600 }}>{label}</div>
        <div style={{ fontSize: 12, color: "var(--orvyn-text-muted)", margin: "6px 0 14px" }}>{server.description}</div>
        {step === 0 && (
          <>
            <Meta row="Publisher" value={server.publisher ?? "—"} />
            <Meta row="Version" value={server.version ?? "latest (will pin)"} />
            <Meta row="Source" value={server.sources.map((s) => SOURCE_LABEL[s]).join(", ")} />
            <Meta row="Repository" value={server.repository ?? "—"} />
            <Meta row="Trust" value={`${server.trust.level} — ${server.trust.reasons.join("; ")}`} />
            <Meta row="Compatibility" value={`${server.compatibility}${server.compatibilityReason ? ` · ${server.compatibilityReason}` : ""}`} />
            <Meta row="Network" value={server.networkRequired ? "Network access required" : "No remote endpoint advertised"} />
            {server.qualityNote && <Meta row="External signal" value={server.qualityNote} />}
            {!!server.tools?.length && (
              <div style={{ marginTop: 14 }}>
                <div style={{ fontSize: 11, fontWeight: 600, marginBottom: 6 }}>Tools</div>
                {server.tools.slice(0, 24).map((t) => (
                  <div key={t.name} style={{ fontSize: 11.5, padding: "4px 0", borderBottom: "1px solid var(--orvyn-border-soft)" }}>
                    <code>{t.name}</code>
                    <span style={{ color: "var(--orvyn-text-muted)" }}> · {t.risk} — {t.description.slice(0, 80)}</span>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
        {step === 1 && (
          <div style={{ fontSize: 13, lineHeight: 1.6 }}>
            <div>This server can:</div>
            <div>✓ use the advertised {server.transports.map((t) => t.kind).join(" / ")} transport</div>
            {server.networkRequired && <div>⚠ reach the network</div>}
            <div>⚠ call write or side-effect tools only after ToolGateway approval</div>
            <div style={{ marginTop: 10, color: "var(--orvyn-text-muted)", fontSize: 12 }}>
              Destructive and unknown tools default to Ask. Full Access still cannot bypass hard policy.
            </div>
          </div>
        )}
        {step === 2 && (
          <>
            <div style={{ fontSize: 12, color: "var(--orvyn-text-muted)", marginBottom: 8 }}>{server.auth[0]?.label ?? "No auth advertised"}</div>
            <input
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="API token (stored as a secret reference, never in config)"
              style={searchInput}
            />
          </>
        )}
        {step === 3 && (
          <div style={{ fontSize: 13 }}>
            Ready to {server.transports.some((t) => t.kind === "http") ? "connect" : "install"} {label}.
            {server.version ? ` Version ${server.version} will be pinned.` : ""} Executable servers start only after this confirmation.
          </div>
        )}
        {step === 4 && <div style={{ fontSize: 13 }}>Installed. Tools appear in Tools & MCP after a successful test connection. ORION discovers them via search_capabilities — not by loading the catalog.</div>}
        <div style={{ display: "flex", gap: 8, marginTop: 22 }}>
          <button onClick={onClose} style={ghostBtn}>Close</button>
          {step < 3 && <button onClick={() => setStep(step + 1)} style={primaryBtn}>Continue</button>}
          {step === 3 && (
            <button disabled={busy} onClick={() => { onInstall(token ? { token } : undefined); setStep(4); }} style={primaryBtn}>
              {busy ? "Working…" : "Confirm"}
            </button>
          )}
        </div>
      </aside>
    </div>
  );
}

function PrivateRegistries({ onSaved }: { onSaved: () => void }) {
  const [name, setName] = useState("Organization registry");
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  async function save() {
    await fetch(apiUrl("/mcp/marketplace/registries"), {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ name, url, token }),
    });
    setToken("");
    onSaved();
  }
  return (
    <div style={{ maxWidth: 480 }}>
      <div style={{ fontSize: 13, color: "var(--orvyn-text-muted)", marginBottom: 12 }}>
        Add a private MCP registry that speaks the Official Registry API (`/v0.1/servers`). Bearer tokens are stored as secret references.
      </div>
      <input style={searchInput} value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" />
      <input style={{ ...searchInput, marginTop: 8 }} value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://registry.example.com" />
      <input style={{ ...searchInput, marginTop: 8 }} type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="Bearer token (optional)" />
      <button onClick={() => void save()} style={{ ...primaryBtn, marginTop: 12 }}>Save registry</button>
      <ImportExport />
    </div>
  );
}

function UpdatesList({ updates }: { updates: { serverId: string; name: string; current: string; changelog: string }[] }) {
  if (!updates.length) {
    return <div style={{ fontSize: 13, color: "var(--orvyn-text-muted)", padding: "20px 0" }}>No installed MCP servers to update.</div>;
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {updates.map((u) => (
        <div key={u.serverId} style={card}>
          <div style={{ fontSize: 14, fontWeight: 600 }}>{u.name}</div>
          <div style={{ fontSize: 12, color: "var(--orvyn-text-muted)", margin: "4px 0 8px" }}>Current pin: {u.current}</div>
          <div style={{ fontSize: 12, color: "var(--orvyn-text-secondary)", lineHeight: 1.45 }}>{u.changelog}</div>
        </div>
      ))}
    </div>
  );
}

function ImportExport() {
  const [raw, setRaw] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  async function preview() {
    try {
      const parsed = JSON.parse(raw);
      const res = await fetch(apiUrl("/mcp/marketplace/import"), {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ config: parsed, confirm: false }),
      });
      const data = await res.json();
      setMsg(`${data.drafts?.length ?? 0} servers found. Secrets were stripped. Confirm to import.`);
    } catch (err: any) {
      setMsg(err.message);
    }
  }
  async function confirm() {
    const parsed = JSON.parse(raw);
    const res = await fetch(apiUrl("/mcp/marketplace/import"), {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ config: parsed, confirm: true }),
    });
    const data = await res.json();
    setMsg(`Imported ${data.imported ?? 0} servers. Re-enter secrets in Installed.`);
  }
  async function exp() {
    const res = await fetch(apiUrl("/mcp/marketplace/export"), { headers: authHeaders() });
    const data = await res.json();
    setRaw(JSON.stringify(data, null, 2));
    setMsg("Exported non-secret MCP config.");
  }
  return (
    <div style={{ marginTop: 28 }}>
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>Import / export</div>
      <div style={{ fontSize: 12, color: "var(--orvyn-text-muted)", marginBottom: 8 }}>
        Paste Cursor, Claude Desktop, or VS Code MCP JSON. Source files are never overwritten. Secrets stay out of the export.
      </div>
      <textarea
        value={raw}
        onChange={(e) => setRaw(e.target.value)}
        rows={8}
        style={{ ...searchInput, fontFamily: "var(--font-mono)", fontSize: 11, resize: "vertical" }}
        placeholder='{ "mcpServers": { "github": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"] } } }'
      />
      {msg && <div style={{ fontSize: 12, color: "var(--orvyn-text-secondary)", margin: "8px 0" }}>{msg}</div>}
      <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
        <button onClick={() => void preview()} style={ghostBtn}>Preview import</button>
        <button onClick={() => void confirm()} style={primaryBtn}>Confirm import</button>
        <button onClick={() => void exp()} style={ghostBtn}>Export</button>
      </div>
    </div>
  );
}

function ProviderPills({ health }: { health: Health[] }) {
  if (!health.length) return null;
  return (
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
      {health.map((h) => (
        <span key={h.id} title={h.detail} style={{ ...badge, opacity: h.status === "online" ? 1 : 0.7 }}>
          {h.name}: {h.status}
        </span>
      ))}
    </div>
  );
}

function Meta({ row, value }: { row: string; value: string }) {
  return (
    <div style={{ display: "flex", gap: 10, fontSize: 12, padding: "5px 0", borderBottom: "1px solid var(--orvyn-border-soft)" }}>
      <span style={{ width: 110, color: "var(--orvyn-text-muted)", flexShrink: 0 }}>{row}</span>
      <span style={{ wordBreak: "break-all" }}>{value}</span>
    </div>
  );
}

const searchInput: React.CSSProperties = {
  width: "100%",
  background: "var(--orvyn-bg, #0B0E14)",
  border: "1px solid var(--orvyn-border)",
  borderRadius: 10,
  color: "var(--orvyn-text)",
  fontSize: 14,
  padding: "12px 14px",
  outline: "none",
};
const card: React.CSSProperties = {
  background: "var(--orvyn-surface-2, #121724)",
  border: "1px solid var(--orvyn-border-soft)",
  borderRadius: 12,
  padding: 14,
};
const badge: React.CSSProperties = {
  fontSize: 9.5,
  letterSpacing: 0.4,
  textTransform: "uppercase",
  border: "1px solid var(--orvyn-border)",
  borderRadius: 99,
  padding: "2px 7px",
  color: "var(--orvyn-text-secondary)",
};
const ghostBtn: React.CSSProperties = {
  background: "transparent",
  border: "1px solid var(--orvyn-border)",
  borderRadius: 7,
  color: "var(--orvyn-text-secondary)",
  fontSize: 12,
  padding: "6px 12px",
  cursor: "pointer",
};
const primaryBtn: React.CSSProperties = {
  background: "var(--orvyn-purple, #5563F5)",
  border: "none",
  borderRadius: 7,
  color: "#fff",
  fontSize: 12,
  fontWeight: 600,
  padding: "6px 14px",
  cursor: "pointer",
};
function tabBtn(on: boolean): React.CSSProperties {
  return {
    background: on ? "rgba(85,99,245,0.18)" : "transparent",
    border: `1px solid ${on ? "var(--orvyn-purple, #5563F5)" : "var(--orvyn-border)"}`,
    borderRadius: 8,
    color: on ? "var(--orvyn-text)" : "var(--orvyn-text-muted)",
    fontSize: 12,
    padding: "6px 12px",
    cursor: "pointer",
  };
}
function chip(on: boolean): React.CSSProperties {
  return { ...tabBtn(on), borderRadius: 99, padding: "4px 10px", fontSize: 11 };
}
