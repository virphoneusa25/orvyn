// Normalized MCP Marketplace models. Providers map vendor payloads onto
// these types; ORION never sees the raw catalog — only search_capabilities
// results and activated tool schemas.

import type { ProviderHealthStatus } from "./providerRuntime";

export type RegistrySource = "official" | "glama" | "smithery" | "local" | "private";

export type TrustLevel = "verified" | "community" | "unverified" | "blocked";

export type Compatibility = "compatible" | "limited" | "unsupported";

export type AuthKind = "none" | "bearer" | "oauth" | "api_key" | "custom";

export type PackageRegistry = "npm" | "pypi" | "uvx" | "docker" | "binary" | "remote";

export type ToolRiskTag =
  | "read"
  | "write"
  | "execute"
  | "network"
  | "destructive"
  | "credential-sensitive"
  | "financial"
  | "external-side-effect";

export interface RegistrySearch {
  query: string;
  cursor?: string;
  limit?: number;
  category?: string;
  refresh?: boolean;
}

export interface RegistryHealth {
  id: string;
  name: string;
  status: ProviderHealthStatus;
  detail?: string;
  latencyMs?: number;
  resultCount?: number;
  errorClass?: string;
}

export interface McpPackage {
  registry: PackageRegistry;
  identifier: string;
  version?: string;
  transportHint?: "stdio" | "http";
}

export interface McpTransportDescriptor {
  kind: "stdio" | "http";
  command?: string;
  args?: string[];
  url?: string;
  headers?: { name: string; secret?: boolean; required?: boolean }[];
}

export interface AuthRequirement {
  kind: AuthKind;
  label: string;
  envVar?: string;
}

export interface TrustMetadata {
  level: TrustLevel;
  reasons: string[];
  verifiedChecks?: string[];
}

export interface InstalledMetadata {
  serverId: string;
  version?: string;
  enabled: boolean;
  state: string;
  lastUsedAt?: number;
}

export interface MarketplaceToolSummary {
  name: string;
  description: string;
  risk: ToolRiskTag;
  origin?: "declared" | "live";
}

export interface MarketplaceMcpServer {
  canonicalId: string;
  name: string;
  title?: string;
  description: string;
  publisher?: string;
  sources: RegistrySource[];
  repository?: string;
  homepage?: string;
  categories: string[];
  packages: McpPackage[];
  remotes?: { url: string }[];
  transports: McpTransportDescriptor[];
  tools?: MarketplaceToolSummary[];
  auth: AuthRequirement[];
  trust: TrustMetadata;
  installed?: InstalledMetadata;
  compatibility: Compatibility;
  compatibilityReason?: string;
  toolCount?: number;
  version?: string;
  license?: string;
  qualityNote?: string;
  networkRequired: boolean;
  filesystemScope: "none" | "project" | "selected" | "full";
  iconUrl?: string;
  executionLocation?: "local" | "remote";
  health?: string;
}

export interface MarketplaceTool {
  canonicalId: string;
  serverId: string;
  serverName: string;
  name: string;
  description: string;
  risk: ToolRiskTag;
}

export interface RegistryResult {
  server: MarketplaceMcpServer;
  score: number;
  matchedTools?: MarketplaceToolSummary[];
}

export interface RegistrySearchChunk {
  results: RegistryResult[];
  cursor?: string;
  health?: RegistryHealth;
}

export interface McpRegistryProvider {
  id: RegistrySource;
  name: string;
  search(query: RegistrySearch): Promise<RegistrySearchChunk>;
  getServer?(id: string): Promise<MarketplaceMcpServer | null>;
  health?(): Promise<RegistryHealth>;
}

export interface MarketplaceSearchResponse {
  results: RegistryResult[];
  health: RegistryHealth[];
  providers: Record<string, RegistryHealth>;
  degraded: string[];
  degradedFlag: boolean;
  fromCache: boolean;
  stale?: boolean;
  cursor?: string;
  diagnostics?: {
    cache: "hit" | "stale" | "miss";
    resultCount: number;
    dedupeCount: number;
    providerLatency: Record<string, number>;
  };
}

export const MARKETPLACE_CATEGORIES = [
  "Developer Tools",
  "Version Control",
  "Databases",
  "Cloud",
  "Containers",
  "Kubernetes",
  "Infrastructure",
  "Browser",
  "Search",
  "Communication",
  "Email",
  "CRM",
  "Project Management",
  "Observability",
  "Security",
  "Finance",
  "Payments",
  "Files",
  "Documents",
  "AI & ML",
  "Telecom",
  "Automation",
] as const;

export const DEFAULT_TOOL_BUDGET = { maxServers: 8, maxTools: 40 };

export const MARKETPLACE_CATALOG_VERSION = 1;
export const MARKETPLACE_INSTALL_API_VERSION = 1;
export const SUPPORTED_MARKETPLACE_PROVIDERS = ["official", "glama", "smithery", "local", "private"] as const;

export const OFFICIAL_REGISTRY_URL = "https://registry.modelcontextprotocol.io";
export const GLAMA_API_URL = "https://glama.ai/api/mcp";
export const SMITHERY_API_URL = "https://api.smithery.ai";
