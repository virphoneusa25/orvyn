// Package provenance + install-script inspection. Signals are attributed,
// never a definitive malware verdict.

export interface ProvenanceRecord {
  package?: string;
  version?: string;
  registry?: string;
  publisher?: string;
  repository?: string;
  claimedRepository?: string;
  integrity?: string;
  installSource?: string;
  installedAt: number;
  scripts?: string[];
  scriptWarning?: string;
  repositoryMismatch?: boolean;
  signals: string[];
}

export type NpmFetch = (url: string) => Promise<{ ok: boolean; status: number; json: () => Promise<any> }>;

export function pinRequired(version?: string): string | null {
  if (!version || version === "latest" || version === "*" || version.startsWith("^") || version.startsWith("~")) {
    return "Version must be pinned (exact x.y.z). Floating latest is not installed silently.";
  }
  return null;
}

export function scriptsFromManifest(manifest: any): string[] {
  const scripts = manifest?.scripts && typeof manifest.scripts === "object" ? manifest.scripts : {};
  return ["preinstall", "install", "postinstall"].filter((k) => typeof scripts[k] === "string" && scripts[k].trim());
}

export async function inspectNpmPackage(
  identifier: string,
  version: string,
  fetchImpl: NpmFetch = fetch as NpmFetch
): Promise<ProvenanceRecord> {
  const pin = pinRequired(version);
  if (pin) throw new Error(pin);
  const encoded = identifier.replace("/", "%2f");
  const res = await fetchImpl(`https://registry.npmjs.org/${encoded}/${encodeURIComponent(version)}`);
  if (!res.ok) {
    return {
      package: identifier,
      version,
      registry: "npm",
      installedAt: Date.now(),
      signals: [`npm metadata unavailable (HTTP ${res.status})`],
    };
  }
  const body = await res.json();
  const scripts = scriptsFromManifest(body);
  const repo = String(body.repository?.url ?? body.repository ?? "").replace(/^git\+/, "").replace(/\.git$/, "");
  const dist = body.dist ?? {};
  const signals: string[] = [];
  if (scripts.length) signals.push(`install scripts: ${scripts.join(", ")}`);
  if (body.bin) signals.push("declares binaries");
  if (typeof body.os === "object") signals.push("native / OS-specific package");
  return {
    package: identifier,
    version: String(body.version ?? version),
    registry: "npm",
    publisher: body._npmUser?.name ?? body.maintainers?.[0]?.name,
    repository: repo || undefined,
    integrity: dist.integrity ?? dist.shasum,
    installedAt: Date.now(),
    scripts,
    scriptWarning: scripts.length ? `This package runs ${scripts.join(", ")} during install.` : undefined,
    signals,
  };
}

export function flagRepositoryMismatch(claimed?: string, published?: string): boolean {
  if (!claimed || !published) return false;
  const a = claimed.replace(/\.git$/, "").replace(/\/$/, "").toLowerCase();
  const b = published.replace(/\.git$/, "").replace(/\/$/, "").toLowerCase();
  return !a.endsWith(b.replace(/^https?:\/\/github.com\//, "")) && !b.includes(a.replace(/^https?:\/\/(www\.)?/, ""));
}

export function riskSignals(input: {
  scripts?: string[];
  networkRequired?: boolean;
  filesystemScope?: string;
  nativeBinary?: boolean;
  provenanceGap?: boolean;
}): string[] {
  const out: string[] = [];
  if (input.scripts?.length) out.push("install-script");
  if (input.networkRequired) out.push("network");
  if (input.filesystemScope && input.filesystemScope !== "none") out.push("filesystem");
  if (input.nativeBinary) out.push("native-binary");
  if (input.provenanceGap) out.push("unusual-provenance");
  return out;
}
