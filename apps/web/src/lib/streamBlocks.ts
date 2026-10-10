import type { AgentProgressEvent } from "./agentProgress";

export interface ChatActivity {
  id: string;
  kind: string;
  status?: string;
  query?: string;
  url?: string;
  title?: string;
  results?: number;
  error?: string;
}

export interface DiffLine {
  type: string;
  content: string;
}

export interface FileEditCard {
  path: string;
  status: "editing" | "created" | "modified" | "deleted" | "moved";
  additions: number;
  deletions: number;
  diff: DiffLine[];
  pending: boolean;
  note?: string;
  openPath?: string;
}

const FILE_TOOLS = new Set(["write_file", "create_file", "apply_patch", "edit_file", "delete_file", "move_file"]);

export function upsertActivity(list: ChatActivity[], next: ChatActivity): ChatActivity[] {
  const i = list.findIndex((a) => a.id === next.id);
  if (i < 0) return [...list, next];
  const copy = [...list];
  copy[i] = { ...copy[i], ...next };
  return copy;
}

function hostOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url.replace(/^https?:\/\//, "").slice(0, 80); }
}

export function collapseReadFailures(items: ChatActivity[]): ChatActivity[] {
  const out: ChatActivity[] = [];
  const failedHosts = new Set<string>();
  for (const item of items) {
    if (item.kind === "read" && item.status === "failed") {
      const host = hostOf(item.url || item.error || "");
      if (host && failedHosts.has(host)) continue;
      if (host) failedHosts.add(host);
      const error = item.error && /OpenShell|host \*|request_network_access/i.test(item.error)
        ? `Could not read ${host || "the page"} — the site blocked automated access.`
        : item.error;
      out.push({ ...item, error });
      continue;
    }
    out.push(item);
  }
  return out;
}

export function activityLabel(a: ChatActivity): string {
  const running = a.status === "running" || a.status === "pending";
  if (a.kind === "search") {
    const q = a.query?.trim() ? ` for “${a.query.trim()}”` : "";
    return running ? `Searching the web${q}` : `Searched the web${q}`;
  }
  if (a.kind === "read") {
    const target = a.title?.trim() || (a.url ? hostOf(a.url) : "a page");
    return running ? `Reading ${target}` : `Read ${target}`;
  }
  if (a.kind === "handoff") return running ? "Starting project work" : "Started project work";
  if (a.kind === "capability") return running ? "Looking for a capability" : "Found a capability";
  return running ? "Working" : "Done";
}

export function fileEditsFromEvents(events: AgentProgressEvent[]): FileEditCard[] {
  const byPath = new Map<string, FileEditCard>();
  const callPath = new Map<string, string>();
  const previousEdit = new Map<string, FileEditCard | undefined>();
  const callTool = new Map<string, string>();
  const put = (path: string, patch: Partial<FileEditCard>) => {
    const key = path.replace(/\\/g, "/");
    if (!key) return;
    const prev = byPath.get(key) ?? { path: key, status: "modified" as const, additions: 0, deletions: 0, diff: [], pending: false };
    byPath.set(key, { ...prev, ...patch, path: key });
  };

  for (const event of events) {
    const data = event.data ?? {};
    const callId = String(data.callId ?? "");
    const tool = String(data.tool ?? data.name ?? "");
    const args = (data.args ?? data.input ?? {}) as Record<string, unknown>;
    const argPath = String(args.path ?? args.from ?? args.to ?? data.path ?? "");

    if (event.type === "tool.started" && FILE_TOOLS.has(tool) && callId) {
      callTool.set(callId, tool);
      if (argPath) {
        callPath.set(callId, argPath);
        if (!previousEdit.has(callId)) previousEdit.set(callId, byPath.get(argPath.replace(/\\/g, "/")));
        put(argPath, { pending: true, status: "editing" });
      } else {
        callPath.set(callId, "");
      }
    }
    if (event.type === "tool.input" && callId && (FILE_TOOLS.has(tool) || callPath.has(callId))) {
      if (argPath) {
        const previous = callPath.get(callId);
        if (previous && previous !== argPath) byPath.delete(previous);
        callPath.set(callId, argPath);
        if (!previousEdit.has(callId)) previousEdit.set(callId, byPath.get(argPath.replace(/\\/g, "/")));
        put(argPath, { pending: true, status: "editing", openPath: typeof args.to === "string" ? args.to : undefined });
      }
    }
    if (event.type === "file.created" && data.path) {
      put(String(data.path), { status: "created", pending: false });
    }
    if (event.type === "file.edit") {
      const preview = (data.preview ?? {}) as { path?: string; kind?: string; additions?: number; deletions?: number; diff?: DiffLine[]; note?: string };
      const path = String(data.path || preview.path || "");
      const kind = String(preview.kind || data.op || "modify");
      put(path, {
        pending: false,
        openPath: typeof data.to === "string" ? data.to : path,
        status: kind === "create" ? "created" : kind === "delete" ? "deleted" : kind === "move" ? "moved" : "modified",
        additions: Number(preview.additions ?? 0) || 0,
        deletions: Number(preview.deletions ?? 0) || 0,
        diff: Array.isArray(preview.diff) ? preview.diff : [],
        note: typeof preview.note === "string" ? preview.note : undefined,
      });
    }
    if ((event.type === "tool.completed" || event.type === "tool.failed") && callId && callPath.has(callId)) {
      const path = callPath.get(callId)!.replace(/\\/g, "/");
      if (event.type === "tool.failed") {
        const previous = previousEdit.get(callId);
        if (previous) byPath.set(path, previous); else byPath.delete(path);
      } else if (byPath.get(path)?.pending) {
        const name = callTool.get(callId);
        put(path, { pending: false, status: name === "delete_file" ? "deleted" : name === "move_file" ? "moved" : "modified", note: "File operation completed; an inline diff was not supplied." });
      }
      callPath.delete(callId); previousEdit.delete(callId); callTool.delete(callId);
    }
  }
  if (events.some(event => /^run\.(completed|partial|error|cancelled)$/.test(event.type))) {
    for (const [id, path] of callPath) {
      const key = path.replace(/\\/g, "/");
      if (!byPath.get(key)?.pending) continue;
      const previous = previousEdit.get(id);
      if (previous) byPath.set(key, previous); else byPath.delete(key);
    }
  }
  return [...byPath.values()];
}
