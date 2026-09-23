import type { Compatibility, MarketplaceMcpServer, ToolRiskTag, TrustLevel } from "./types";

const CATEGORY_HINTS: Array<[string, RegExp]> = [
  ["Version Control", /git|github|gitlab|bitbucket|pull.?request|commit/i],
  ["Databases", /postgres|mysql|sqlite|mongo|redis|sql|database/i],
  ["Cloud", /aws|azure|gcp|cloudflare|vercel|netlify|s3/i],
  ["Containers", /docker|podman|container/i],
  ["Kubernetes", /kubernetes|k8s|helm/i],
  ["Browser", /browser|playwright|puppeteer|chrome/i],
  ["Communication", /slack|discord|teams|chat/i],
  ["Email", /email|smtp|imap|gmail/i],
  ["CRM", /salesforce|hubspot|crm|zendesk/i],
  ["Project Management", /jira|linear|asana|notion|trello/i],
  ["Observability", /grafana|prometheus|datadog|sentry|log/i],
  ["Security", /vault|secret|snyk|osv|auth/i],
  ["Payments", /stripe|paypal|billing/i],
  ["Finance", /finance|ledger|invoice/i],
  ["Files", /filesystem|file|s3|drive/i],
  ["Documents", /docs|pdf|markdown|notion/i],
  ["AI & ML", /openai|llm|embedding|vector/i],
  ["Telecom", /sip|voip|twilio|telnyx|dns|e911|yealink/i],
  ["Automation", /automat|workflow|n8n|zapier/i],
  ["Infrastructure", /terraform|ansible|nginx|dns/i],
  ["Developer Tools", /sdk|cli|lint|test|build/i],
];

export function inferCategories(name: string, description: string): string[] {
  const text = `${name} ${description}`;
  const hits = CATEGORY_HINTS.filter(([, re]) => re.test(text)).map(([c]) => c);
  return hits.length ? [...new Set(hits)].slice(0, 4) : ["Developer Tools"];
}

export function classifyMarketplaceRisk(name: string, description = ""): ToolRiskTag {
  const text = `${name} ${description}`;
  if (/(delete|destroy|drop|wipe|purge|rm\b)/i.test(text)) return "destructive";
  if (/(payment|stripe|invoice|charge|refund)/i.test(text)) return "financial";
  if (/(token|secret|password|credential|api.?key)/i.test(text)) return "credential-sensitive";
  if (/(http|fetch|request|webhook|send|email|slack|deploy)/i.test(text)) return "network";
  if (/(exec|run|shell|command|install)/i.test(text)) return "execute";
  if (/(create|write|update|edit|patch|post|put|merge|commit)/i.test(text)) return "write";
  if (/(list|get|read|search|fetch|query|show|describe)/i.test(text)) return "read";
  return "external-side-effect";
}

export function compatibilityOf(server: Pick<MarketplaceMcpServer, "transports">): {
  compatibility: Compatibility;
  reason: string;
} {
  const kinds = new Set(server.transports.map((t) => t.kind));
  if (kinds.has("http") || kinds.has("stdio")) {
    return { compatibility: "compatible", reason: kinds.has("http") && kinds.has("stdio") ? "stdio and Streamable HTTP" : kinds.has("http") ? "Streamable HTTP" : "local stdio" };
  }
  return { compatibility: "unsupported", reason: "No stdio or Streamable HTTP transport advertised" };
}

export function trustFor(input: {
  sources: string[];
  publisher?: string;
  repository?: string;
  verified?: boolean;
  blocked?: boolean;
}): { level: TrustLevel; reasons: string[]; verifiedChecks?: string[] } {
  if (input.blocked) return { level: "blocked", reasons: ["On the ORVYN blocklist"] };
  if (input.verified) {
    return {
      level: "verified",
      reasons: ["Listed in the ORVYN verified catalog"],
      verifiedChecks: ["publisher identity", "official registry listing", "known source repository"],
    };
  }
  const official = input.sources.includes("official");
  const knownPub = /modelcontextprotocol|github|anthropic|cloudflare/i.test(`${input.publisher ?? ""} ${input.repository ?? ""}`);
  if (official && knownPub) {
    return { level: "community", reasons: ["Official MCP Registry", "Recognized publisher"] };
  }
  if (official) return { level: "community", reasons: ["Official MCP Registry"] };
  if (input.sources.includes("local")) return { level: "community", reasons: ["Manually added by this workspace"] };
  if (input.sources.includes("private")) return { level: "community", reasons: ["Organization / private registry"] };
  return { level: "unverified", reasons: ["Third-party directory listing only"] };
}

export function networkRequired(server: Pick<MarketplaceMcpServer, "transports" | "packages" | "description">): boolean {
  if (server.transports.some((t) => t.kind === "http")) return true;
  return /http|api|cloud|remote|network/i.test(server.description);
}

export function filesystemScope(text: string): MarketplaceMcpServer["filesystemScope"] {
  if (/entire disk|full filesystem|\/home|C:\\/i.test(text)) return "full";
  if (/workspace|project|cwd|current (folder|directory)/i.test(text)) return "project";
  if (/file|folder|path/i.test(text)) return "selected";
  return "none";
}

export function searchTokens(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !STOP.has(t));
}

const STOP = new Set(["the", "and", "for", "with", "from", "that", "this", "into", "your", "our", "a", "an", "to", "of", "on", "in", "is", "it"]);

const SEARCH_META = new Set(["official", "mcp", "server", "servers", "tool", "tools", "registry", "catalog", "marketplace"]);

export function catalogSearchQuery(query: string): string {
  const tokens = searchTokens(query).filter((t) => !SEARCH_META.has(t));
  return tokens.join(" ") || query.trim();
}

export function primarySearchTerm(query: string): string {
  const tokens = searchTokens(catalogSearchQuery(query));
  const brands = tokens.find((t) =>
    /github|gitlab|postgres|postgresql|slack|stripe|aws|cloudflare|docker|kubernetes|jira|notion|twilio|redis|mongo|linear|sentry/.test(t)
  );
  return brands || tokens[0] || query.trim();
}
