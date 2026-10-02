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
}

const FILE_TOOLS = new Set(["write_file", "edit_file", "delete_file", "move_file"]);

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
    const argPath = String(args.path ?? args.to ?? args.from ?? data.path ?? "");

    if (event.type === "tool.started" && FILE_TOOLS.has(tool) && callId) {
      if (argPath) {
        callPath.set(callId, argPath);
        put(argPath, { pending: true, status: tool === "write_file" ? "created" : tool === "delete_file" ? "deleted" : tool === "move_file" ? "moved" : "editing" });
      } else {
        callPath.set(callId, "");
      }
    }
    if (event.type === "tool.input" && callId && (FILE_TOOLS.has(tool) || callPath.has(callId))) {
      if (argPath) {
        const previous = callPath.get(callId);
        if (previous && previous !== argPath) byPath.delete(previous);
        callPath.set(callId, argPath);
        put(argPath, { pending: true });
      }
    }
    if (event.type === "file.created" && data.path) {
      put(String(data.path), { status: "created", pending: false });
    }
    if (event.type === "file.edit") {
      const preview = (data.preview ?? {}) as { path?: string; kind?: string; additions?: number; deletions?: number; diff?: DiffLine[]; note?: string };
      const path = String(preview.path || data.path || "");
      const kind = String(preview.kind || data.op || "modify");
      put(path, {
        pending: false,
        status: kind === "create" ? "created" : kind === "delete" ? "deleted" : kind === "move" ? "moved" : "modified",
        additions: Number(preview.additions ?? 0) || 0,
        deletions: Number(preview.deletions ?? 0) || 0,
        diff: Array.isArray(preview.diff) ? preview.diff : [],
        note: typeof preview.note === "string" ? preview.note : undefined,
      });
    }
    if ((event.type === "tool.completed" || event.type === "tool.failed") && callId && callPath.has(callId)) {
      put(callPath.get(callId)!, { pending: event.type === "tool.failed" ? false : false });
    }
  }
  return [...byPath.values()];
}
