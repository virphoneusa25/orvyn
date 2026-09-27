// Binds the Workbench to the canonical WorkSession workspace.
// The Files pane lists this root — never a folder the renderer guessed.

import { extractOrionCommands, type WorkspaceDiff, type WorkspaceEvent, type WorkspaceFile } from "./agentWorkspaceModel.ts";
import { toProjectRelative } from "./filesPanelModel.ts";

export const NO_WORKSPACE_LABEL = "No workspace yet";
export const NEW_WORKSPACE_LABEL = "New workspace";

export interface WorkbenchIdentity {
  sessionId: string;
  projectId: string;
  workspaceId: string;
  projectRoot: string;
  created: boolean;
  restored: boolean;
}

export interface WorkbenchSessionSnapshot {
  sessionId: string;
  projectId: string | null;
  workspaceId: string | null;
  projectRoot: string | null;
  created?: boolean;
  restored?: boolean;
  files?: { path: string; operation: string }[];
  preview?: { url: string; available?: boolean } | null;
}

export interface WorkbenchChange extends WorkspaceDiff {
  kind: string;
}

export interface WorkbenchSurface {
  status: "none" | "created" | "restored";
  label: string;
  identity: WorkbenchIdentity | null;
  /** Directory the Files pane may list. Null when no project exists. */
  listRoot: string | null;
  /** Written project files, relative to listRoot. Deleted paths are omitted. */
  files: { path: string; kind: WorkspaceFile["kind"] }[];
  /** Mutations and diffs. Reads are not changes. */
  changes: WorkbenchChange[];
  changeFiles: WorkspaceFile[];
  commands: { id: string; command: string; output: string; running: boolean }[];
  previewUrl: string | null;
  /** Shared ORION/user browser target: the browser event, or the project preview. */
  browserUrl: string | null;
  summary: { files: number; additions: number; deletions: number };
}

const SENTINEL = "/opt/orvyn/workspaces";

export function normalizeWorkspaceRoot(root: string): string {
  return root.trim().replace(/\\/g, "/").replace(/\/+$/, "");
}

export function sameWorkspaceRoot(a: string | null | undefined, b: string | null | undefined): boolean {
  const norm = (p: string) => {
    const r = normalizeWorkspaceRoot(p);
    return /^[A-Za-z]:\//.test(r) ? r.toLowerCase() : r;
  };
  return Boolean(a && b) && norm(a!) === norm(b!);
}

/** Empty, dot, the desktop sentinel, and the built-in app workspace are not projects. */
export function isUntrustedWorkbenchRoot(root: string | null | undefined): boolean {
  if (!root || !root.trim()) return true;
  const n = normalizeWorkspaceRoot(root);
  if (!n || n === "." || n === "./") return true;
  const lower = n.toLowerCase();
  if (lower === SENTINEL) return true;
  if (lower.includes("appdata") && lower.includes("@orvyn") && lower.endsWith("workspace")) return true;
  return false;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function identityFrom(data: {
  sessionId?: string | null;
  projectId?: string | null;
  workspaceId?: string | null;
  projectRoot?: string | null;
  created?: boolean;
  restored?: boolean;
} | null | undefined): WorkbenchIdentity | null {
  if (!data) return null;
  const sessionId = text(data.sessionId);
  const projectId = text(data.projectId);
  const workspaceId = text(data.workspaceId);
  const projectRoot = text(data.projectRoot);
  if (!sessionId || !projectId || !workspaceId || isUntrustedWorkbenchRoot(projectRoot)) return null;
  const created = data.created === true;
  const restored = data.restored === true || !created;
  return {
    sessionId,
    projectId,
    workspaceId,
    projectRoot: normalizeWorkspaceRoot(projectRoot),
    created: created && !restored,
    restored,
  };
}

function eventIdentity(events: WorkspaceEvent[]): WorkbenchIdentity | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.type !== "workspace.resolved" && e.type !== "run.session") continue;
    const data = e.data ?? {};
    const hit = identityFrom({
      sessionId: text(data.sessionId),
      projectId: text(data.projectId),
      workspaceId: text(data.workspaceId),
      projectRoot: text(data.projectRoot),
      created: data.created === true,
      restored: data.restored === true,
    });
    if (hit) return hit;
  }
  return null;
}

/** A path inside the resolved root, or null when it escapes or belongs elsewhere. */
export function relativeProjectPath(raw: string, projectRoot: string): string | null {
  const rel = toProjectRelative(raw, projectRoot).replace(/\\/g, "/").replace(/^\.\//, "");
  if (!rel || rel === "." || rel === "..") return null;
  if (rel.startsWith("../") || rel.includes("/../") || rel.endsWith("/..")) return null;
  if (rel.startsWith("/") || /^[A-Za-z]:\//.test(rel)) return null;
  return rel;
}

function kindFromOperation(operation: string): WorkspaceFile["kind"] {
  const s = operation.toLowerCase();
  if (/delet|remov/.test(s)) return "deleted";
  if (/write|creat|new|add/.test(s)) return "created";
  return "modified";
}

function collectMutations(events: WorkspaceEvent[], session: WorkbenchSessionSnapshot | null | undefined, root: string): Map<string, WorkbenchChange> {
  const map = new Map<string, WorkbenchChange>();
  const put = (raw: string, kind: string, additions: number, deletions: number, diff?: WorkspaceDiff["diff"]) => {
    const path = relativeProjectPath(raw, root);
    if (!path) return;
    const prev = map.get(path);
    const nextKind = prev?.kind === "create" && kind !== "delete" ? "create" : kind;
    map.delete(path);
    map.set(path, {
      path,
      kind: nextKind,
      additions: diff || additions ? additions : (prev?.additions ?? additions),
      deletions: diff || deletions ? deletions : (prev?.deletions ?? deletions),
      diff: diff ?? prev?.diff,
    });
  };
  for (const file of session?.files ?? []) {
    if (!file?.path) continue;
    const kind = kindFromOperation(file.operation);
    put(file.path, kind === "created" ? "create" : kind === "deleted" ? "delete" : "edit", 0, 0);
  }
  for (const e of events) {
    const data = e.data ?? {};
    if (e.type === "file.created") {
      const path = String(data.path ?? "");
      if (path) put(path, "create", 0, 0);
    }
    if (e.type === "file.edit") {
      const preview = data.preview as WorkspaceDiff | undefined;
      const path = String(preview?.path ?? data.path ?? "");
      if (!path) continue;
      const kind = preview?.kind === "delete" ? "delete" : preview?.kind === "create" ? "create" : "edit";
      put(path, kind, Number(preview?.additions ?? 0), Number(preview?.deletions ?? 0), preview?.diff);
    }
  }
  return map;
}

function projectPreview(events: WorkspaceEvent[], session: WorkbenchSessionSnapshot | null | undefined): string | null {
  let url: string | null = null;
  for (const e of events) {
    if (e.type === "preview.available" && typeof e.data?.url === "string" && e.data.url) url = e.data.url;
  }
  if (url) return url;
  const saved = session?.preview?.url;
  return saved ? saved : null;
}

function browserTarget(events: WorkspaceEvent[]): string | null {
  let url: string | null = null;
  for (const e of events) {
    const data = e.data ?? {};
    const tool = String(data.tool ?? "");
    if (!e.type.startsWith("browser.") && !tool.startsWith("browser_")) continue;
    const next = String(data.url ?? (data.input as { url?: string } | undefined)?.url ?? "");
    if (next) url = next;
  }
  return url;
}

export function workspaceChromeLabel(
  surface: Pick<WorkbenchSurface, "status">,
  projectName: string | null | undefined,
  electronRoot: string | null | undefined,
  listRoot: string | null
): string {
  if (surface.status === "none") return NO_WORKSPACE_LABEL;
  if (surface.status === "created") return NEW_WORKSPACE_LABEL;
  if (projectName?.trim() && sameWorkspaceRoot(electronRoot, listRoot)) return projectName.trim();
  return "Workspace";
}

/** True only when Electron is already sitting on the resolved project root. */
export function shouldListDisk(listRoot: string | null, electronRoot: string | null | undefined): boolean {
  return Boolean(listRoot && electronRoot && sameWorkspaceRoot(listRoot, electronRoot));
}

export function sameWorkspace(a: WorkbenchIdentity | null | undefined, b: WorkbenchIdentity | null | undefined): boolean {
  if (!a || !b) return false;
  return a.sessionId === b.sessionId
    && a.projectId === b.projectId
    && a.workspaceId === b.workspaceId
    && sameWorkspaceRoot(a.projectRoot, b.projectRoot);
}

export function projectWorkbench(input: {
  events?: WorkspaceEvent[];
  session?: WorkbenchSessionSnapshot | null;
  guessedRoot?: string | null;
}): WorkbenchSurface {
  const events = input.events ?? [];
  const fromEvents = eventIdentity(events);
  const fromSession = identityFrom(input.session);
  const identity = fromEvents ?? fromSession;
  if (!identity) {
    return {
      status: "none",
      label: NO_WORKSPACE_LABEL,
      identity: null,
      listRoot: null,
      files: [],
      changes: [],
      changeFiles: [],
      commands: extractOrionCommands(events),
      previewUrl: null,
      browserUrl: browserTarget(events),
      summary: { files: 0, additions: 0, deletions: 0 },
    };
  }
  const status = identity.created && !identity.restored ? "created" : "restored";
  const mutations = [...collectMutations(events, input.session, identity.projectRoot).values()];
  const changes = mutations.filter((m) => m.kind !== "read");
  let additions = 0;
  let deletions = 0;
  for (const c of changes) {
    additions += c.additions;
    deletions += c.deletions;
  }
  const fileKind = (kind: string): WorkspaceFile["kind"] =>
    kind === "create" ? "created" : kind === "delete" ? "deleted" : "modified";
  const previewUrl = projectPreview(events, input.session);
  const browserUrl = browserTarget(events) || previewUrl;
  return {
    status,
    label: status === "created" ? NEW_WORKSPACE_LABEL : "Workspace",
    identity,
    listRoot: identity.projectRoot,
    files: changes.filter((c) => c.kind !== "delete").map((c) => ({ path: c.path, kind: fileKind(c.kind) })),
    changes,
    changeFiles: changes.map((c) => ({
      path: c.path,
      kind: fileKind(c.kind),
      additions: c.additions,
      deletions: c.deletions,
      status: c.kind === "create" ? "Created" : c.kind === "delete" ? "Deleted" : "Modified",
    })),
    commands: extractOrionCommands(events),
    previewUrl,
    browserUrl,
    summary: { files: changes.length, additions, deletions },
  };
}
