// Pure marketplace presentation model. Keeps Tools & MCP → Marketplace
// logic testable without rewriting McpManager / federation search.

export type MarketSource = "official" | "glama" | "local" | "private";

export type DetailTab = "details" | "tools" | "permissions" | "configuration" | "security" | "source" | "changelog";

export interface MarketTool {
  name: string;
  description: string;
  risk: string;
  permission?: "ALLOW" | "ASK" | "DENY";
  active?: boolean;
  inputSchema?: Record<string, unknown>;
}

export interface MarketServer {
  canonicalId: string;
  name: string;
  title?: string;
  description: string;
  publisher?: string;
  sources: MarketSource[];
  repository?: string;
  homepage?: string;
  categories: string[];
  transports: { kind: "stdio" | "http"; command?: string; args?: string[]; url?: string }[];
  tools?: MarketTool[];
  auth: { kind: string; label: string }[];
  trust: { level: string; reasons: string[] };
  installed?: {
    serverId: string;
    enabled: boolean;
    state: string;
    scope?: "global" | "project" | "run";
    authKind?: string;
    lastError?: string;
    lastConnectedAt?: number;
  };
  compatibility: string;
  compatibilityReason?: string;
  toolCount?: number;
  version?: string;
  license?: string;
  qualityNote?: string;
  networkRequired: boolean;
  filesystemScope?: "none" | "project" | "selected" | "full";
  packages?: { registry: string; identifier: string; version?: string; integrity?: string }[];
  provenance?: { integrity?: string; scripts?: string[]; registry?: string };
  iconUrl?: string;
}

export interface MarketFilters {
  sources: MarketSource[];
  status: "" | "installed" | "not-installed" | "needs-auth" | "update";
  trust: "" | "verified" | "community" | "unverified";
  execution: "" | "local" | "cloud" | "remote";
  transport: "" | "stdio" | "http";
  category: string;
}

export interface UpdateRow {
  serverId: string;
  name: string;
  current: string;
  available?: string | null;
  changelog: string;
}

export interface Recommendation {
  server: MarketServer;
  reason: string;
}

export const EMPTY_FILTERS: MarketFilters = {
  sources: [],
  status: "",
  trust: "",
  execution: "",
  transport: "",
  category: "",
};

export const DETAIL_TABS: { id: DetailTab; label: string }[] = [
  { id: "details", label: "Details" },
  { id: "tools", label: "Tools" },
  { id: "permissions", label: "Permissions" },
  { id: "configuration", label: "Configuration" },
  { id: "security", label: "Security" },
  { id: "source", label: "Source" },
  { id: "changelog", label: "Changelog" },
];

export const SOURCE_LABEL: Record<MarketSource, string> = {
  official: "Official",
  glama: "Glama",
  local: "Local",
  private: "Private",
};

export const SIDEBAR_MIN = 320;
export const SIDEBAR_COMPACT = 240;
export const SIDEBAR_DEFAULT = 380;
export const SIDEBAR_MAX = 520;
/** Detail + list need this much or the list becomes a drawer. */
export const MARKETPLACE_SPLIT_MIN = 640;
export const DETAIL_MIN = 420;
export const TOOL_BUDGET = { maxServers: 8, maxTools: 40 };

export function prettifyMarketName(raw: string): string {
  const s = String(raw ?? "")
    .trim()
    .replace(/^io\.[^/]+\//, "")
    .replace(/^@[^/]+\//, "");
  if (!s) return "MCP server";
  if (!/[-_]/.test(s) || s.length < 16) return s;
  return s
    .replace(/[-_]+/g, " ")
    .replace(/\bmcp\b/gi, "MCP")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export function serverLabel(server: MarketServer): string {
  const titled = (server.title ?? "").trim();
  if (titled && !/^[-_.a-z0-9]+$/i.test(titled.replace(/\s+/g, ""))) return titled;
  if (titled && !/[-_]/.test(titled)) return titled;
  return prettifyMarketName(titled || server.name.split("/").pop() || server.name);
}

export function executionLocation(server: MarketServer): "local" | "remote" {
  return server.transports.some((t) => t.kind === "http") ? "remote" : "local";
}

export function transportLabel(server: MarketServer): string {
  const kinds = server.transports.map((t) => (t.kind === "http" ? "Streamable HTTP" : "stdio"));
  return kinds.length ? [...new Set(kinds)].join(" · ") : "transport unknown";
}

export function toolCount(server: MarketServer): number {
  return server.toolCount ?? server.tools?.length ?? 0;
}

/** Catalog listings almost never advertise a tools[] payload. Showing "0 tools"
 *  made every Official Registry server look empty. Tell the truth instead. */
export function toolsAdvertisedLabel(server: MarketServer): string {
  const n = toolCount(server);
  if (n > 0) return `${n} tool${n === 1 ? "" : "s"}`;
  if (server.installed) return "tools discovered after connect";
  return "tools listed after connect";
}

export function isNeedsAuth(server: MarketServer): boolean {
  return server.installed?.state === "NEEDS_AUTH";
}

export function isConnected(server: MarketServer): boolean {
  return server.installed?.state === "CONNECTED";
}

export function applyFilters(servers: MarketServer[], filters: MarketFilters, updateIds: Set<string> = new Set()): MarketServer[] {
  return servers.filter((s) => {
    if (filters.sources.length && !filters.sources.some((src) => s.sources.includes(src))) return false;
    if (filters.status === "installed" && !s.installed) return false;
    if (filters.status === "not-installed" && s.installed) return false;
    if (filters.status === "needs-auth" && !isNeedsAuth(s)) return false;
    if (filters.status === "update" && !(s.installed && updateIds.has(s.installed.serverId))) return false;
    if (filters.trust && s.trust.level !== filters.trust) return false;
    if (filters.execution === "local" && executionLocation(s) !== "local") return false;
    if (filters.execution === "remote" && executionLocation(s) !== "remote") return false;
    if (filters.execution === "cloud" && executionLocation(s) !== "remote") return false;
    if (filters.transport && !s.transports.some((t) => t.kind === filters.transport)) return false;
    if (filters.category && !s.categories.includes(filters.category)) return false;
    return true;
  });
}

export function filterActiveCount(filters: MarketFilters): number {
  return (
    filters.sources.length +
    (filters.status ? 1 : 0) +
    (filters.trust ? 1 : 0) +
    (filters.execution ? 1 : 0) +
    (filters.transport ? 1 : 0) +
    (filters.category ? 1 : 0)
  );
}

export function groupMarketplace(
  servers: MarketServer[],
  updates: UpdateRow[],
  recommended: Recommendation[]
): {
  installed: MarketServer[];
  discover: MarketServer[];
  recommended: Recommendation[];
  updates: UpdateRow[];
  private: MarketServer[];
} {
  const installed = servers.filter((s) => s.installed);
  const privateServers = servers.filter((s) => s.sources.includes("private"));
  const recIds = new Set(recommended.map((r) => r.server.canonicalId));
  const discover = servers.filter((s) => !s.installed && !recIds.has(s.canonicalId));
  return { installed, discover, recommended, updates, private: privateServers };
}

export type PrimaryAction = "install" | "connect" | "connected" | "disable" | "enable" | "update";

export function primaryAction(server: MarketServer, hasUpdate = false): { kind: PrimaryAction; label: string } {
  if (hasUpdate) return { kind: "update", label: "Update" };
  if (!server.installed) return { kind: "install", label: server.transports.some((t) => t.kind === "http") ? "Connect" : "Install" };
  if (isNeedsAuth(server) || (server.auth.some((a) => a.kind === "oauth") && server.installed.state !== "CONNECTED")) {
    return { kind: "connect", label: "Connect" };
  }
  if (server.installed.state === "CONNECTED") return { kind: "connected", label: "Connected" };
  if (server.installed.enabled === false || server.installed.state === "DISABLED") return { kind: "enable", label: "Enable" };
  return { kind: "disable", label: "Disable" };
}

export function permissionSummary(server: MarketServer): { can: string[]; may: string[] } {
  const can: string[] = [];
  const may: string[] = [];
  const loc = executionLocation(server);
  can.push(loc === "remote" ? "Reach a remote Streamable HTTP endpoint" : "Run a local stdio process on this machine");
  if (server.filesystemScope && server.filesystemScope !== "none") {
    can.push(server.filesystemScope === "project" ? "Read the selected project workspace" : "Access files in the advertised scope");
  }
  if (server.networkRequired || loc === "remote") can.push("Use the network for the advertised API");
  const tools = server.tools ?? [];
  const writes = tools.filter((t) => /write|destructive|external/i.test(t.risk));
  const reads = tools.filter((t) => /read/i.test(t.risk));
  if (reads.length) can.push("Expose read tools classified by ORVYN");
  if (writes.length) {
    may.push("Create or modify remote resources (Ask by default)");
    if (writes.some((t) => /destructive/i.test(t.risk))) may.push("Run destructive tools after ToolGateway approval");
  } else {
    may.push("Call write or side-effect tools only after ToolGateway approval");
  }
  return { can, may };
}

export function recommendServers(
  servers: MarketServer[],
  ctx: { query?: string; projectHints?: string[] } = {}
): Recommendation[] {
  const q = `${ctx.query ?? ""} ${(ctx.projectHints ?? []).join(" ")}`.toLowerCase();
  const out: Recommendation[] = [];
  const push = (server: MarketServer | undefined, reason: string) => {
    if (!server || out.some((r) => r.server.canonicalId === server.canonicalId)) return;
    out.push({ server, reason });
  };
  if (/github|pull request|pull-request|\bpr\b/.test(q)) {
    push(
      servers.find((s) => /github/i.test(s.name) && s.sources.includes("official")) ??
        servers.find((s) => /github/i.test(s.name)),
      "Recommended because ORION asked for GitHub / pull-request capabilities."
    );
  }
  if (/postgres|postgresql|\bsql\b|database/.test(q)) {
    push(
      servers.find((s) => /postgres/i.test(s.name)),
      "Recommended because this workspace looks like it needs a database MCP."
    );
  }
  if (/slack|email|voip|sip/.test(q)) {
    push(
      servers.find((s) => new RegExp(q.split(/\s+/)[0] || "x", "i").test(s.name)),
      "Recommended because it matches the requested capability."
    );
  }
  if (!q.trim()) {
    push(
      servers.find((s) => /io\.github\.github\/github-mcp|github\/github-mcp-server/i.test(s.name)) ??
        servers.find((s) => /^(github|github mcp)$/i.test(s.title ?? "") || (/github/i.test(s.name) && s.sources.includes("official") && !/obsidian/i.test(s.name))),
      "Official GitHub MCP — pull requests, issues, and repositories."
    );
    push(
      servers.find((s) => /postgres/i.test(`${s.name} ${s.title ?? ""}`)),
      "PostgreSQL MCP for project databases."
    );
    push(
      servers.find((s) => /slack/i.test(`${s.name} ${s.title ?? ""}`)),
      "Slack MCP for workspace messages."
    );
  }
  for (const s of servers.filter((x) => x.trust.level === "verified" && !x.installed)) {
    if (out.length >= 6) break;
    push(s, "Organization-trusted / ORVYN Verified and not yet installed.");
  }
  return out.slice(0, 6);
}

export function selectByOffset(ids: string[], current: string | null, delta: number): string | null {
  if (!ids.length) return null;
  const i = current ? ids.indexOf(current) : -1;
  const next = i < 0 ? (delta >= 0 ? 0 : ids.length - 1) : Math.max(0, Math.min(ids.length - 1, i + delta));
  return ids[next];
}

export function tabAvailable(tab: DetailTab, server: MarketServer, changelog?: string): boolean {
  if (tab === "changelog") return Boolean(changelog && changelog.trim() && !/does not auto-upgrade/i.test(changelog));
  return true;
}

export function mergeInstalled(
  catalog: MarketServer[],
  statuses: {
    id: string;
    name: string;
    state: string;
    enabled: boolean;
    toolCount?: number;
    tools?: MarketTool[];
    scope?: "global" | "project" | "run";
    authKind?: string;
    lastError?: string;
    lastConnectedAt?: number;
    transport?: "stdio" | "http";
  }[]
): MarketServer[] {
  const byName = new Map(statuses.map((s) => [s.name.toLowerCase(), s]));
  const merged = catalog.map((s) => {
    const st = (s.installed && statuses.find((x) => x.id === s.installed!.serverId)) || byName.get(s.name.toLowerCase()) || byName.get(serverLabel(s).toLowerCase());
    if (!st) return s;
    return {
      ...s,
      installed: {
        serverId: st.id,
        enabled: st.enabled,
        state: st.state,
        scope: st.scope,
        authKind: st.authKind,
        lastError: st.lastError,
        lastConnectedAt: st.lastConnectedAt,
      },
      toolCount: st.toolCount ?? s.toolCount,
      tools: st.tools?.length ? st.tools : s.tools,
    };
  });
  const seen = new Set(merged.filter((s) => s.installed).map((s) => s.installed!.serverId));
  for (const st of statuses) {
    if (seen.has(st.id)) continue;
    merged.push({
      canonicalId: `local:${st.id}`,
      name: st.name,
      description: "Installed locally — not from the current search page.",
      sources: ["local"],
      categories: [],
      transports: [{ kind: st.transport === "http" ? "http" : "stdio" }],
      auth: st.authKind ? [{ kind: st.authKind, label: st.authKind }] : [],
      trust: { level: "community", reasons: ["local"] },
      compatibility: "compatible",
      networkRequired: st.transport === "http",
      installed: {
        serverId: st.id,
        enabled: st.enabled,
        state: st.state,
        scope: st.scope,
        authKind: st.authKind,
        lastError: st.lastError,
        lastConnectedAt: st.lastConnectedAt,
      },
      toolCount: st.toolCount,
      tools: st.tools,
    });
  }
  return merged;
}

export function uninstallCopy(server: MarketServer): string {
  return `${serverLabel(server)} will be removed from this account. Secret references are deleted; remote tokens are revoked when the provider supports it. Scope and config are not kept. The catalog listing stays discoverable.`;
}

export function clampSidebar(width: number): number {
  return Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, Math.round(width)));
}

/** Overlay only when the marketplace pane itself cannot fit detail + list.
 *  480 was too late — both columns stayed visible and the title wrapped
 *  character-by-character beside Desktop/Review. */
export function overlaySidebar(containerWidth: number): boolean {
  return containerWidth > 0 && containerWidth < MARKETPLACE_SPLIT_MIN;
}

/** Keep a usable left detail pane when Tools & MCP shares the window with Desktop. */
export function sidebarForContainer(containerWidth: number, current = SIDEBAR_DEFAULT): number {
  if (containerWidth >= 960) return clampSidebar(current);
  if (containerWidth >= 720) return Math.min(current, 300);
  if (containerWidth >= 480) return Math.min(current, SIDEBAR_COMPACT);
  return SIDEBAR_COMPACT;
}

export function pickSelectedServer(
  filtered: MarketServer[],
  recommended: Recommendation[],
  selectedId: string | null
): MarketServer | null {
  if (selectedId) {
    const hit = filtered.find((s) => s.canonicalId === selectedId);
    if (hit) return hit;
  }
  return recommended[0]?.server ?? filtered[0] ?? null;
}

export function initials(server: MarketServer): string {
  const label = serverLabel(server);
  const cleaned = label.replace(/\bmcp\b/gi, "").trim();
  const parts = cleaned.split(/[\s/_-]+/).filter(Boolean);
  const tokens = parts.flatMap((part) =>
    part.split(/(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/).filter(Boolean)
  );
  if (tokens[0] && tokens[1]) return (tokens[0][0] + tokens[1][0]).toUpperCase();
  const word = tokens[0] ?? "MC";
  return word.slice(0, 2).toUpperCase();
}

export function formatRisk(risk: string): string {
  return risk
    .split(/[|/,]+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => part.replace(/[-_]/g, " ").toUpperCase())
    .join(" · ");
}

export function schemaArgNames(schema?: Record<string, unknown>): string[] {
  if (!schema || typeof schema !== "object") return [];
  const props = schema.properties;
  if (!props || typeof props !== "object") return [];
  return Object.keys(props as Record<string, unknown>).slice(0, 12);
}

export function providerWarning(health: { id: string; name: string; status: string; detail?: string }[]): string[] {
  return health
    .filter((h) => h.status !== "online" && h.status !== "disabled")
    .map((h) => (h.status === "needs-key" ? `${h.name} needs a key` : `${h.name} unavailable`));
}
