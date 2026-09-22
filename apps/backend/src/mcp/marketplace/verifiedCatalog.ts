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
