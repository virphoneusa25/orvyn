import { compatibilityOf, inferCategories, trustFor } from "./classify";
import type { MarketplaceMcpServer, RegistryResult } from "./types";

export type OfficialLanguage = "typescript" | "python";

export interface OfficialReferenceSpec {
  name: string;
  title: string;
  description: string;
  language: OfficialLanguage;
  registry: "npm" | "pypi";
  identifier: string;
  version: string;
  keywords: string[];
  networkRequired: boolean;
  filesystemScope: MarketplaceMcpServer["filesystemScope"];
}

/** First-party MCP reference servers from modelcontextprotocol/servers.
 *  They are published on npm/PyPI but often missing from Official Registry search. */
export const OFFICIAL_REFERENCE_SERVERS: OfficialReferenceSpec[] = [
  {
    name: "io.modelcontextprotocol/filesystem",
    title: "Filesystem",
    description:
      "Official JavaScript / TypeScript MCP reference server for secure file operations with configurable directory access.",
    language: "typescript",
    registry: "npm",
    identifier: "@modelcontextprotocol/server-filesystem",
    version: "2026.8.31",
    keywords: ["javascript", "js", "typescript", "ts", "node", "nodejs", "filesystem", "files", "file"],
    networkRequired: false,
    filesystemScope: "selected",
  },
  {
    name: "io.modelcontextprotocol/memory",
    title: "Memory",
    description: "Official JavaScript / TypeScript MCP reference server that stores a knowledge graph for persistent memory.",
    language: "typescript",
    registry: "npm",
    identifier: "@modelcontextprotocol/server-memory",
    version: "2026.8.31",
    keywords: ["javascript", "js", "typescript", "ts", "node", "nodejs", "memory", "knowledge"],
    networkRequired: false,
    filesystemScope: "none",
  },
  {
    name: "io.modelcontextprotocol/everything",
    title: "Everything",
    description: "Official JavaScript / TypeScript MCP reference server that exercises prompts, resources, and tools.",
    language: "typescript",
    registry: "npm",
    identifier: "@modelcontextprotocol/server-everything",
    version: "2026.8.31",
    keywords: ["javascript", "js", "typescript", "ts", "node", "nodejs", "everything", "reference"],
    networkRequired: false,
    filesystemScope: "none",
  },
  {
    name: "io.modelcontextprotocol/sequential-thinking",
    title: "Sequential Thinking",
    description: "Official JavaScript / TypeScript MCP reference server for step-by-step problem solving.",
    language: "typescript",
    registry: "npm",
    identifier: "@modelcontextprotocol/server-sequential-thinking",
    version: "2026.8.31",
    keywords: ["javascript", "js", "typescript", "ts", "node", "nodejs", "thinking", "reason"],
    networkRequired: false,
    filesystemScope: "none",
  },
  {
    name: "io.modelcontextprotocol/git",
    title: "Git",
    description: "Official Python MCP reference server for reading, searching, and changing Git repositories.",
    language: "python",
    registry: "pypi",
    identifier: "mcp-server-git",
    version: "2026.8.18",
    keywords: ["python", "py", "pypi", "uvx", "git", "repository"],
    networkRequired: false,
    filesystemScope: "project",
  },
  {
    name: "io.modelcontextprotocol/fetch",
    title: "Fetch",
    description: "Official Python MCP reference server for fetching web pages and converting them for LLM use.",
    language: "python",
    registry: "pypi",
    identifier: "mcp-server-fetch",
    version: "2026.8.18",
    keywords: ["python", "py", "pypi", "uvx", "fetch", "http", "web"],
    networkRequired: true,
    filesystemScope: "none",
  },
  {
    name: "io.modelcontextprotocol/time",
    title: "Time",
    description: "Official Python MCP reference server for time queries and timezone conversion.",
    language: "python",
    registry: "pypi",
    identifier: "mcp-server-time",
    version: "2026.8.18",
    keywords: ["python", "py", "pypi", "uvx", "time", "timezone"],
    networkRequired: false,
    filesystemScope: "none",
  },
];

const JS_TERMS = new Set(["js", "javascript", "typescript", "ts", "node", "nodejs"]);
const PY_TERMS = new Set(["python", "py", "pypi", "uvx"]);

const REFERENCE_PACKAGES = new Set(
  OFFICIAL_REFERENCE_SERVERS.map((s) => s.identifier.toLowerCase())
);

export function isOfficialReferenceServer(server: {
  name?: string;
  canonicalId?: string;
  repository?: string;
  packages?: { identifier?: string }[];
}): boolean {
  const id = `${server.canonicalId ?? ""} ${server.name ?? ""}`.toLowerCase();
  if (id.includes("io.modelcontextprotocol/")) return true;
  const pkgs = (server.packages ?? []).map((p) => (p.identifier ?? "").toLowerCase());
  return pkgs.some((p) => REFERENCE_PACKAGES.has(p));
}

/** First-party MCP org + GitHub's official server. Community registry listings are excluded. */
export function isFirstPartyOfficialServer(server: {
  name?: string;
  title?: string;
  canonicalId?: string;
  publisher?: string;
  repository?: string;
  packages?: { identifier?: string }[];
  sources?: string[];
}): boolean {
  if (isOfficialReferenceServer(server)) return true;
  const id = `${server.canonicalId ?? ""} ${server.name ?? ""}`.toLowerCase();
  const repo = `${server.repository ?? ""}`.toLowerCase();
  const publisher = `${server.publisher ?? ""}`.toLowerCase();
  if (publisher === "io.modelcontextprotocol" || /github\.com\/modelcontextprotocol\//i.test(repo)) return true;
  if (publisher === "io.github.github" || /io\.github\.github\/github-mcp-server/i.test(id)) return true;
  if (/github\.com\/github\/github-mcp-server/i.test(repo)) return true;
  return false;
}

/** Marketplace catalog is official-only. Installed/local/private servers still appear. */
export function keepMarketplaceListing(
  server: {
    name?: string;
    title?: string;
    canonicalId?: string;
    publisher?: string;
    repository?: string;
    packages?: { identifier?: string }[];
    sources?: string[];
    installed?: unknown;
  },
  providerId?: string
): boolean {
  if (providerId === "local" || providerId === "private") return true;
  if ((server.sources ?? []).some((s) => s === "local" || s === "private")) return true;
  if (server.installed) return true;
  return isFirstPartyOfficialServer(server);
}

export function officialReferenceById(id: string): MarketplaceMcpServer | null {
  const key = id.replace(/^(official|glama|smithery|local|private):/i, "").toLowerCase();
  const spec = OFFICIAL_REFERENCE_SERVERS.find(
    (s) => s.name.toLowerCase() === key || s.identifier.toLowerCase() === key
  );
  return spec ? toMarketplace(spec) : null;
}

export function officialReferenceResults(query: string): RegistryResult[] {
  return matchingOfficialReferences(query).map((spec) => ({ server: toMarketplace(spec), score: 0 }));
}

export function matchingOfficialReferences(query: string): OfficialReferenceSpec[] {
  const tokens = languageQueryTokens(query);
  if (!tokens.length) return [...OFFICIAL_REFERENCE_SERVERS];
  return OFFICIAL_REFERENCE_SERVERS.filter((spec) => officialReferenceMatches(tokens, spec));
}

export function officialReferenceMatches(tokens: string[], spec: OfficialReferenceSpec): boolean {
  if (tokens.some((t) => JS_TERMS.has(t)) && spec.language === "typescript") return true;
  if (tokens.some((t) => PY_TERMS.has(t)) && spec.language === "python") return true;
  const hay = `${spec.name} ${spec.title} ${spec.identifier} ${spec.keywords.join(" ")}`.toLowerCase();
  return tokens.some((t) => spec.keywords.includes(t) || hay.includes(t));
}

export function languageQueryTokens(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !SEARCH_META.has(t));
}

export const SEARCH_META = new Set([
  "official",
  "mcp",
  "server",
  "servers",
  "tool",
  "tools",
  "registry",
  "catalog",
  "marketplace",
  "the",
  "and",
  "for",
]);

function toMarketplace(spec: OfficialReferenceSpec): MarketplaceMcpServer {
  const npm = spec.registry === "npm";
  const pkgId = spec.identifier;
  const args = npm ? ["-y", `${pkgId}@${spec.version}`] : [pkgId];
  const draft: MarketplaceMcpServer = {
    canonicalId: spec.name,
    name: spec.name,
    title: spec.title,
    description: spec.description,
    publisher: "io.modelcontextprotocol",
    sources: ["official"],
    repository: "https://github.com/modelcontextprotocol/servers",
    homepage: "https://modelcontextprotocol.io/examples",
    iconUrl: "https://github.com/modelcontextprotocol.png?size=80",
    categories: inferCategories(spec.title, spec.description),
    packages: [{ registry: spec.registry, identifier: pkgId, version: spec.version, transportHint: "stdio" }],
    remotes: [],
    transports: [{ kind: "stdio", command: npm ? "npx" : "uvx", args }],
    tools: [],
    auth: [{ kind: "none", label: "No auth advertised" }],
    trust: trustFor({
      sources: ["official"],
      publisher: "io.modelcontextprotocol",
      repository: "https://github.com/modelcontextprotocol/servers",
      verified: true,
    }),
    compatibility: "compatible",
    version: spec.version,
    license: "MIT",
    networkRequired: spec.networkRequired,
    filesystemScope: spec.filesystemScope,
    executionLocation: "local",
    qualityNote: spec.language === "typescript" ? "Official TypeScript / Node.js reference server" : "Official Python reference server",
  };
  const compat = compatibilityOf(draft);
  draft.compatibility = compat.compatibility;
  draft.compatibilityReason = compat.reason;
  return draft;
}
