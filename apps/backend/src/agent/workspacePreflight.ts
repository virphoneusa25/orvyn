// Resolves WorkSession → project → workspace → projectRoot before file tools run.
// A new file task gets one provisioned directory. A follow-up gets that same
// directory back. A client path of ".", the process cwd, the shared virtual
// workspace, or "/opt/orvyn/workspaces" is never treated as the project.

import { existsSync, mkdirSync, readdirSync, realpathSync, statSync } from "fs";
import path from "path";
import { looksLikeForeignAbsolutePath, virtualWorkspaceRoot } from "../documents/workspace";
import { inferTaskIntent } from "./taskIntent";
import { normalizeKnownFile, rootKey, type WorkSession, type WorkSessionStore } from "../sessions/WorkSessionStore";

export const WORKSPACE_STATE_MISMATCH = "WORKSPACE_STATE_MISMATCH";

const DESKTOP_PLACEHOLDER = "/opt/orvyn/workspaces";
const SKIP = new Set(["node_modules", "dist", ".git", "previews", ".orvyn", "coverage", "build", "out"]);

export interface WorkspaceIdentity {
  sessionId: string;
  projectId: string;
  workspaceId: string;
  projectRoot: string;
  created: boolean;
  restored: boolean;
  /** True when this directory was just provisioned and has no project files yet. */
  fresh: boolean;
}

export interface WorkspaceResolved extends WorkspaceIdentity {
  status: "resolved";
}

export interface WorkspaceMismatch {
  status: "mismatch";
  code: typeof WORKSPACE_STATE_MISMATCH;
  sessionId: string;
  projectId: string;
  workspaceId: string;
  projectRoot: string;
  created: false;
  restored: false;
  message: string;
}

export interface WorkspaceSkipped {
  status: "skipped";
}

export type WorkspacePreflightResult = WorkspaceResolved | WorkspaceMismatch | WorkspaceSkipped;

export interface WorkspacePreflightInput {
  sessions: WorkSessionStore;
  tenantId: string;
  session: WorkSession;
  instruction: string;
  composerMode?: string;
  /** Folder the client claims. Empty, ".", and placeholders are ignored. */
  clientRoot?: string | null;
  /** Only an explicit switch may leave the session's workspace. */
  switchProject?: boolean;
  cwd?: string;
}

/** A file-producing task. Informational chat does not allocate a workspace. */
export function needsActionWorkspace(instruction: string, composerMode?: string): boolean {
  const intent = inferTaskIntent(instruction, composerMode);
  if (intent.informational) return false;
  if (intent.requiresFrontend || intent.requiresWorkspace) return true;
  if (intent.category === "code" || intent.category === "deploy" || intent.category === "automation") return true;
  if (/\b(create|write|edit|add|update|implement|fix|build|generate|modify)\b/i.test(instruction) && !intent.requiresArtifact) return true;
  return false;
}

export function isProvisionedWorkspace(projectRoot: string, tenantId: string, dataDir: string): boolean {
  const base = path.resolve(dataDir, "tenants", tenantId, "workspaces");
  const target = path.resolve(projectRoot);
  const rel = path.relative(base, target);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/** Paths that must never become the project root by default. */
export function isUntrustedProjectRoot(raw: string | null | undefined, ctx: { cwd: string; virtualRoot: string }): boolean {
  const text = String(raw ?? "").trim();
  if (!text || text === "." || text === "./") return true;
  const slashed = text.replace(/\\/g, "/").replace(/\/+$/, "");
  if (slashed === DESKTOP_PLACEHOLDER) return true;
  let resolved: string;
  try {
    resolved = path.resolve(text);
  } catch {
    return true;
  }
  if (resolved === path.resolve(ctx.cwd)) return true;
  const virt = path.resolve(ctx.virtualRoot);
  const rel = path.relative(virt, resolved);
  if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) return true;
  return false;
}

export function isTrustedExistingProject(raw: string | null | undefined, ctx: { cwd: string; virtualRoot: string }): boolean {
  const text = String(raw ?? "").trim();
  if (!text || looksLikeForeignAbsolutePath(text) || isUntrustedProjectRoot(text, ctx)) return false;
  try {
    return statSync(path.resolve(text)).isDirectory();
  } catch {
    return false;
  }
}

/** Project files under a workspace, skipping dependency and hidden trees. */
export function listWorkspaceFiles(root: string, limit = 200): string[] {
  if (!root || !existsSync(root)) return [];
  const found: string[] = [];
  const visit = (dir: string, rel: string, depth: number) => {
    if (found.length >= limit || depth > 4) return;
    let entries: import("fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (found.length >= limit) return;
      if (entry.name.startsWith(".") || SKIP.has(entry.name)) continue;
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) visit(path.join(dir, entry.name), child, depth + 1);
      else if (entry.isFile()) found.push(child);
    }
  };
  visit(root, "", 0);
  return found.sort();
}

function knownFilesIntact(root: string, known: string[]): boolean {
  if (!root || !existsSync(root)) return false;
  if (known.length === 0) return true;
  return known.some((rel) => existsSync(path.join(root, rel)));
}

/** What the model should hear. The absolute host path stays off this text. */
export function workspaceModelNote(identity: { created: boolean; restored: boolean; fresh: boolean }): string {
  const lines = [
    "File tools take paths relative to this chat's workspace.",
    "Do not invent another project folder.",
  ];
  if (identity.fresh) {
    lines.push(
      "This workspace was just provisioned for this chat and is empty. That is expected.",
      "Write the requested project files here. For a new website, write index.html and its stylesheet at the workspace root.",
      "An empty new workspace is not an error. If list_directory is empty, create the files. Do not tell the user the project folder is missing."
    );
  } else if (identity.restored) {
    lines.push("This chat is restored in its existing workspace. Read the files already there and modify that project. Do not start a second project.");
  } else if (identity.created) {
    lines.push("This workspace belongs to this chat. Write the requested files here.");
  }
  return lines.join("\n");
}

export function exposeProjectTools(result: WorkspacePreflightResult): result is WorkspaceResolved {
  return result.status === "resolved";
}

function resolved(identity: WorkspaceIdentity): WorkspaceResolved {
  return { status: "resolved", ...identity };
}

function mismatch(session: WorkSession, projectId: string, workspaceId: string, projectRoot: string): WorkspaceMismatch {
  return {
    status: "mismatch",
    code: WORKSPACE_STATE_MISMATCH,
    sessionId: session.sessionId,
    projectId,
    workspaceId,
    projectRoot,
    created: false,
    restored: false,
    message: "Workspace state mismatch: this project previously had files, but the workspace resolved empty. The run was not started in a new folder.",
  };
}

function finish(
  sessions: WorkSessionStore,
  session: WorkSession,
  binding: { workspaceId: string; projectId: string; projectRoot: string },
  flags: { created: boolean; restored: boolean }
): WorkspaceResolved {
  const projectRoot = existsSync(binding.projectRoot) ? realpathSync(binding.projectRoot) : binding.projectRoot;
  sessions.bindWorkspace(session.sessionId, { ...binding, projectRoot });
  const known = sessions.knownFiles(binding.workspaceId);
  if (known.length === 0) {
    const found = listWorkspaceFiles(projectRoot);
    if (found.length) sessions.rememberFiles(binding.workspaceId, found);
  }
  const filesNow = listWorkspaceFiles(projectRoot);
  const fresh = filesNow.length === 0 && sessions.knownFiles(binding.workspaceId).length === 0;
  return resolved({
    sessionId: session.sessionId,
    projectId: binding.projectId,
    workspaceId: binding.workspaceId,
    projectRoot,
    created: flags.created,
    restored: flags.restored,
    fresh,
  });
}

function provision(sessions: WorkSessionStore, session: WorkSession): WorkspaceResolved {
  const created = sessions.provisionWorkspace();
  return finish(sessions, session, created, { created: true, restored: false });
}

function adoptClient(sessions: WorkSessionStore, session: WorkSession, clientRoot: string): WorkspaceResolved {
  const projectRoot = realpathSync(path.resolve(clientRoot));
  const ws = sessions.workspaceFor(projectRoot);
  return finish(sessions, session, { ...ws, projectRoot }, { created: ws.created, restored: !ws.created });
}

/**
 * Resolve the workspace for one run.
 * Existing sessions keep their workspace. A wrong client path does not mint a new one.
 * An existing workspace whose known files are gone is WORKSPACE_STATE_MISMATCH.
 */
export function resolveRunWorkspace(input: WorkspacePreflightInput): WorkspacePreflightResult {
  const session = input.sessions.get(input.session.sessionId) ?? input.session;
  const cwd = input.cwd ?? process.cwd();
  const virtualRoot = virtualWorkspaceRoot(input.tenantId, input.sessions.dataDirectory);
  const ctx = { cwd, virtualRoot };
  const client = String(input.clientRoot ?? "").trim();
  const actionable = needsActionWorkspace(input.instruction, input.composerMode);
  const record = session.workspaceId ? input.sessions.getWorkspace(session.workspaceId) : undefined;

  if (!record && !actionable) return { status: "skipped" };

  if (!record) {
    if (isTrustedExistingProject(client, ctx)) return adoptClient(input.sessions, session, client);
    if (client && looksLikeForeignAbsolutePath(client)) {
      const ws = input.sessions.workspaceFor(client);
      input.sessions.bindWorkspace(session.sessionId, { workspaceId: ws.workspaceId, projectId: ws.projectId, projectRoot: client });
      return resolved({
        sessionId: session.sessionId,
        projectId: ws.projectId,
        workspaceId: ws.workspaceId,
        projectRoot: client,
        created: ws.created,
        restored: !ws.created,
        fresh: false,
      });
    }
    return provision(input.sessions, session);
  }

  if (input.switchProject && isTrustedExistingProject(client, ctx) && rootKey(path.resolve(client)) !== rootKey(record.projectRoot)) {
    return adoptClient(input.sessions, session, client);
  }

  const stored = record.projectRoot;
  const untrusted = isUntrustedProjectRoot(stored, ctx) || stored === "." || path.resolve(stored) === path.resolve(cwd);

  if (!untrusted && knownFilesIntact(stored, record.knownFiles)) {
    if (!existsSync(stored)) mkdirSync(stored, { recursive: true });
    return finish(input.sessions, session, record, { created: false, restored: true });
  }

  if (record.knownFiles.length > 0) {
    // Put the session back on the known workspace. Do not adopt the empty path.
    input.sessions.bindWorkspace(session.sessionId, {
      workspaceId: record.workspaceId,
      projectId: record.projectId,
      projectRoot: stored,
    });
    return mismatch(session, record.projectId, record.workspaceId, stored);
  }

  if (!untrusted) {
    mkdirSync(stored, { recursive: true });
    return finish(input.sessions, session, record, { created: false, restored: true });
  }

  return provision(input.sessions, session);
}

export { normalizeKnownFile };
