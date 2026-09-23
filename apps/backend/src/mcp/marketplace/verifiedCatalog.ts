// Curated ORVYN Verified catalog. IDs only — never thousands of hardcoded
// servers. A match means ORVYN has recorded defined checks, not "secure forever."

export interface VerifiedEntry {
  canonicalId: string;
  repositories?: string[];
  packages?: string[];
  checks: string[];
  notes: string;
}

export const VERIFIED_CATALOG: VerifiedEntry[] = [
  {
    canonicalId: "io.github.github/github-mcp-server",
    repositories: ["https://github.com/github/github-mcp-server"],
    packages: ["@modelcontextprotocol/server-github"],
    checks: ["publisher identity", "official registry listing", "known source repository"],
    notes: "GitHub-published official MCP server",
  },
  {
    canonicalId: "io.modelcontextprotocol/filesystem",
    repositories: ["https://github.com/modelcontextprotocol/servers"],
    packages: ["@modelcontextprotocol/server-filesystem"],
    checks: ["publisher identity", "npm package", "known source repository"],
    notes: "Official TypeScript MCP reference server",
  },
  {
    canonicalId: "io.modelcontextprotocol/memory",
    repositories: ["https://github.com/modelcontextprotocol/servers"],
    packages: ["@modelcontextprotocol/server-memory"],
    checks: ["publisher identity", "npm package", "known source repository"],
    notes: "Official TypeScript MCP reference server",
  },
  {
    canonicalId: "io.modelcontextprotocol/everything",
    repositories: ["https://github.com/modelcontextprotocol/servers"],
    packages: ["@modelcontextprotocol/server-everything"],
    checks: ["publisher identity", "npm package", "known source repository"],
    notes: "Official TypeScript MCP reference server",
  },
  {
    canonicalId: "io.modelcontextprotocol/sequential-thinking",
    repositories: ["https://github.com/modelcontextprotocol/servers"],
    packages: ["@modelcontextprotocol/server-sequential-thinking"],
    checks: ["publisher identity", "npm package", "known source repository"],
    notes: "Official TypeScript MCP reference server",
  },
  {
    canonicalId: "io.modelcontextprotocol/git",
    repositories: ["https://github.com/modelcontextprotocol/servers"],
    packages: ["mcp-server-git"],
    checks: ["publisher identity", "PyPI package", "known source repository"],
    notes: "Official Python MCP reference server",
  },
  {
    canonicalId: "io.modelcontextprotocol/fetch",
    repositories: ["https://github.com/modelcontextprotocol/servers"],
    packages: ["mcp-server-fetch"],
    checks: ["publisher identity", "PyPI package", "known source repository"],
    notes: "Official Python MCP reference server",
  },
  {
    canonicalId: "io.modelcontextprotocol/time",
    repositories: ["https://github.com/modelcontextprotocol/servers"],
    packages: ["mcp-server-time"],
    checks: ["publisher identity", "PyPI package", "known source repository"],
    notes: "Official Python MCP reference server",
  },
];

function normRepo(url?: string): string {
  return (url ?? "").replace(/\.git$/, "").replace(/\/$/, "").toLowerCase();
}

export function verificationFor(input: {
  canonicalId?: string;
  name?: string;
  repository?: string;
  packages?: { identifier?: string }[];
}): { level: "verified"; reasons: string[]; verifiedChecks: string[] } | null {
  const repo = normRepo(input.repository);
  const pkgs = new Set((input.packages ?? []).map((p) => (p.identifier ?? "").toLowerCase()).filter(Boolean));
  const id = (input.canonicalId ?? input.name ?? "").toLowerCase();
  for (const row of VERIFIED_CATALOG) {
    if (row.canonicalId.toLowerCase() === id) {
      return { level: "verified", reasons: [row.notes], verifiedChecks: row.checks };
    }
    if (repo && row.repositories?.some((r) => normRepo(r) === repo)) {
      return { level: "verified", reasons: [row.notes], verifiedChecks: row.checks };
    }
    if ([...pkgs].some((p) => row.packages?.some((rp) => rp.toLowerCase() === p))) {
      return { level: "verified", reasons: [row.notes], verifiedChecks: row.checks };
    }
  }
  return null;
}
