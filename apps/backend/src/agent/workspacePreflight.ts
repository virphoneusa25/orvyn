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
  /** Leave the session workspace for a folder the user picked. */
  switchProject?: boolean;
  /** Start a separate empty project. Does not reuse session.workspaceId. */
  newProject?: boolean;
  /** Start a separate project from this chat. Does not reuse session.workspaceId. */
  forkProject?: boolean;
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
  return known.every((rel) => {
    try {
      return statSync(path.join(root, rel)).isFile();
    } catch {
      return false;
    }
  });
}

/** What the model should hear. The absolute host path stays off this text. */
export function workspaceModelNote(identity: { created: boolean; restored: boolean; fresh: boolean; knownFiles?: string[] }): string {
  const known = (identity.knownFiles ?? []).filter(Boolean);
  const lines = [
    "File tools take paths relative to this chat's workspace.",
    "Do not invent another project folder.",
  ];
  if (identity.restored && known.length > 0) {
    lines.push(
      `This chat is restored in its existing workspace. These project files are already here: ${known.join(", ")}.`,
      `Read ${known.join(" and ")} before changing the project, then edit those files in place.`,
      "Do not say the workspace is empty. Do not say the earlier files did not persist. Do not say there is no project folder. Do not say the site does not exist. Do not start a second project.",
      "The project exists. A stopped preview is not a missing project. If the preview is not running, republish it from these files."
    );
  } else if (identity.restored) {
    lines.push("This chat is restored in its existing workspace. Read the files already there and modify that project. Do not say the workspace is empty. Do not say there is no project folder. Do not start a second project.");
  } else if (identity.fresh) {
    lines.push(
      "This workspace was just provisioned for this chat and has no project files yet. That is expected.",
      "Write the requested project files here. For a new website, write index.html and its stylesheet at the workspace root.",
      "An empty new workspace is not an error. If list_directory is empty, create the files. Do not tell the user the project folder is missing."
    );
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

function explicitProjectChange(input: WorkspacePreflightInput): boolean {
  return input.switchProject === true || input.newProject === true || input.forkProject === true;
}

/**
 * The session already has a workspace. Stay on it.
 * A client path does not mint another directory.
 * Missing known files are a mismatch, not a blank project.
 */
function restoreOwnedWorkspace(
  input: WorkspacePreflightInput,
  session: WorkSession,
  record: { workspaceId: string; projectId: string; projectRoot: string; knownFiles: string[] },
  ctx: { cwd: string; virtualRoot: string }
): WorkspacePreflightResult {
  const stored = record.projectRoot;
  const untrusted = isUntrustedProjectRoot(stored, ctx) || stored === "." || path.resolve(stored) === path.resolve(ctx.cwd);
  const known = input.sessions.knownFiles(record.workspaceId);
  input.sessions.bindWorkspace(session.sessionId, {
    workspaceId: record.workspaceId,
    projectId: record.projectId,
    projectRoot: stored,
  });
  if (untrusted || (known.length > 0 && !knownFilesIntact(stored, known))) {
    return mismatch(session, record.projectId, record.workspaceId, stored);
  }
  if (!existsSync(stored)) mkdirSync(stored, { recursive: true });
  return finish(input.sessions, session, { workspaceId: record.workspaceId, projectId: record.projectId, projectRoot: stored }, { created: false, restored: true });
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
  const leaving = explicitProjectChange(input);

  if (session.workspaceId && !record && !leaving) {
    return mismatch(session, session.projectId ?? "", session.workspaceId, session.projectRoot ?? "");
  }

  if (record && !leaving) return restoreOwnedWorkspace(input, session, record, ctx);

  if (record && input.switchProject && isTrustedExistingProject(client, ctx) && rootKey(path.resolve(client)) !== rootKey(record.projectRoot)) {
    return adoptClient(input.sessions, session, client);
  }

  if (!record && !actionable && !leaving) return { status: "skipped" };

  if (record && (input.newProject || input.forkProject)) return provision(input.sessions, session);

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

  return restoreOwnedWorkspace(input, session, record, ctx);
}

export { normalizeKnownFile };
