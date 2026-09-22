// Parse Cursor / Claude Desktop / VS Code MCP configs into ORVYN addServer
// inputs. Secrets are never copied — only command/url/args and secret *names*.

export interface ImportedServerDraft {
  name: string;
  transport: "stdio" | "http";
  command?: string;
  args?: string[];
  url?: string;
  headers?: Record<string, string>;
  env?: Record<string, string>;
  sourceFormat: "cursor" | "claude-desktop" | "vscode" | "orvyn";
}

export function parseImportedMcpConfig(raw: unknown): ImportedServerDraft[] {
  if (!raw || typeof raw !== "object") return [];
  const obj = raw as Record<string, unknown>;

  if (obj.mcpServers && typeof obj.mcpServers === "object") {
    const format = looksLikeClaude(obj) ? "claude-desktop" : "cursor";
    return fromNamedMap(obj.mcpServers as Record<string, unknown>, format);
  }
  if (obj.servers && typeof obj.servers === "object") {
    return fromNamedMap(obj.servers as Record<string, unknown>, "vscode");
  }
  if (Array.isArray(obj.servers)) {
    return fromNamedMap(
      Object.fromEntries((obj.servers as any[]).map((s, i) => [s.name ?? `server-${i}`, s])),
      "orvyn"
    );
  }
  return [];
}

function looksLikeClaude(obj: Record<string, unknown>): boolean {
  return Object.values((obj.mcpServers as Record<string, unknown>) ?? {}).some(
    (v) => v && typeof v === "object" && "command" in (v as object) && !("url" in (v as object) && (v as any).url)
  );
}

function fromNamedMap(map: Record<string, unknown>, sourceFormat: ImportedServerDraft["sourceFormat"]): ImportedServerDraft[] {
  const out: ImportedServerDraft[] = [];
  for (const [name, value] of Object.entries(map)) {
    if (!value || typeof value !== "object") continue;
    const v = value as Record<string, unknown>;
    const url = typeof v.url === "string" ? v.url : typeof v.serverUrl === "string" ? v.serverUrl : undefined;
    const command = typeof v.command === "string" ? v.command : undefined;
    const args = Array.isArray(v.args) ? v.args.map(String) : undefined;
    const headers = sanitizeHeaders(v.headers);
    const env = sanitizeEnv(v.env);
    if (url) {
      out.push({ name, transport: "http", url, headers, sourceFormat });
    } else if (command) {
      out.push({ name, transport: "stdio", command, args, env, sourceFormat });
    }
  }
  return out;
}

function sanitizeHeaders(raw: unknown): Record<string, string> | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const s = String(v ?? "");
    if (/bearer\s+[a-z0-9._-]{12,}/i.test(s) || /sk-|ghp_|xoxb-|api[_-]?key/i.test(s)) {
      out[k] = "Bearer {{token}}";
    } else {
      out[k] = s;
    }
  }
  return Object.keys(out).length ? out : undefined;
}

function sanitizeEnv(raw: unknown): Record<string, string> | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const s = String(v ?? "");
    if (/secret|token|key|password|credential/i.test(k) || /sk-|ghp_|xoxb-/.test(s)) {
      out[k] = `{{${k.toLowerCase()}}}`;
    } else {
      out[k] = s;
    }
  }
  return Object.keys(out).length ? out : undefined;
}

export function exportOrvynMcpConfig(servers: Array<{
  name: string;
  transport: "stdio" | "http";
  command?: string;
  args?: string[];
  url?: string;
  headers?: Record<string, string>;
  enabled: boolean;
}>): { mcpServers: Record<string, unknown> } {
  const mcpServers: Record<string, unknown> = {};
  for (const s of servers) {
    if (s.transport === "http") {
      mcpServers[s.name] = {
        url: s.url,
        headers: s.headers ? Object.fromEntries(Object.keys(s.headers).map((k) => [k, "{{secret}}"])) : undefined,
        enabled: s.enabled,
      };
    } else {
      mcpServers[s.name] = { command: s.command, args: s.args, enabled: s.enabled };
    }
  }
  return { mcpServers };
}
