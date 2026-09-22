import { mkdirSync } from "fs";
import { join } from "path";
import { defaultDataDir } from "../../persistence/LocalStore";
import type { McpManager } from "../McpManager";
import type { MarketplaceMcpServer } from "./types";

export interface MarketplaceInstallInput {
  server: MarketplaceMcpServer;
  secrets?: Record<string, string>;
  env?: Record<string, string>;
  cwd?: string;
  connect?: boolean;
}

export function installPlan(server: MarketplaceMcpServer): {
  transport: "stdio" | "http";
  command?: string;
  args?: string[];
  url?: string;
  headers?: Record<string, string>;
  version?: string;
  networkRequired: boolean;
} {
  const http = server.transports.find((t) => t.kind === "http" && t.url);
  const stdio = server.transports.find((t) => t.kind === "stdio" && t.command);
  if (http?.url) {
    const headers: Record<string, string> = {};
    for (const h of http.headers ?? []) {
      if (h.secret) headers[h.name] = `Bearer {{${h.name}}}`;
    }
    return { transport: "http", url: http.url, headers, version: server.version, networkRequired: true };
  }
  if (stdio) {
    return {
      transport: "stdio",
      command: stdio.command,
      args: stdio.args,
      version: server.version ?? server.packages[0]?.version,
      networkRequired: server.networkRequired,
    };
  }
  throw new Error("This server has no supported install transport (need stdio or Streamable HTTP).");
}

export async function installMarketplaceServer(manager: McpManager, input: MarketplaceInstallInput) {
  const plan = installPlan(input.server);
  const secretValues: Record<string, string> = {};
  const headers = { ...plan.headers };
  for (const [k, v] of Object.entries(input.secrets ?? {})) {
    secretValues[k] = v;
    if (!headers.Authorization) headers.Authorization = "Bearer {{" + k + "}}";
  }
  const runtimeDir = join(defaultDataDir(), "mcp-runtime", sanitizeId(input.server.name));
  try {
    mkdirSync(runtimeDir, { recursive: true });
  } catch {
    /* directory is best-effort isolation, not a hard requirement */
  }
  const cwd = input.server.filesystemScope === "project" && input.cwd ? input.cwd : runtimeDir;
  const cfg = manager.addServer({
    name: input.server.title || input.server.name.split("/").pop() || input.server.name,
    transport: plan.transport,
    command: plan.command,
    args: plan.args,
    env: input.env,
    cwd: plan.transport === "stdio" ? cwd : input.cwd,
    url: plan.url,
    headers: Object.keys(headers).length ? headers : undefined,
    description: `${input.server.description.slice(0, 180)}${plan.version ? ` · pinned ${plan.version}` : ""}`,
    secretValues: Object.keys(secretValues).length ? secretValues : undefined,
    version: plan.version,
    packageIdentifier: input.server.packages[0]?.identifier,
    marketplaceId: input.server.canonicalId,
    sourceProviders: input.server.sources,
    scope: input.cwd && input.server.filesystemScope === "project" ? "project" : "global",
    executionLocation: plan.transport === "http" ? "remote" : "local",
  });
  if (input.connect) {
    return { config: cfg, status: await manager.connect(cfg.id), plan };
  }
  return { config: cfg, status: manager.status(cfg.id), plan };
}

function sanitizeId(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 64) || "server";
}
