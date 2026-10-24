// apps/backend/src/sessions/sessionState.ts
//
// Everything a WorkSession produced, gathered from its runs: the project it
// works in, its runs, the files it changed, the artifacts it made and the
// newest live preview. Reopening a conversation restores this whole picture,
// so the user continues the same project instead of starting over.

import * as fs from "fs";
import * as path from "path";
import type { AgentEvent, RunStore } from "../agent/events";
import { summarizeRuns, sessionRuns, type ThreadRunSummary } from "../agent/runThread";
import { readPublishedFile } from "../agent/sitePreview";
import type { WorkSession, WorkSessionPersistence as WorkSessionStore } from "./WorkSessionStore";

export interface SessionFile {
  path: string;
  /** The newest thing done to it: write, edit, delete or move. */
  operation: string;
  runId: string;
  at: number;
}

export interface SessionArtifact {
  artifactId: string;
  name: string;
  mimeType?: string;
  runId: string;
  at: number;
}

export interface SessionPreview {
  url: string;
  runId: string;
  at: number;
  /** The page is still served (it survives restarts; false if it was removed). */
  available: boolean;
}

export interface SessionState {
  session: WorkSession;
  runs: ThreadRunSummary[];
  activeRunId: string | null;
  messageCount: number;
  files: SessionFile[];
  artifacts: SessionArtifact[];
  preview: SessionPreview | null;
}

const FILE_OPS = new Set(["write", "edit", "delete", "move"]);
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "coverage"]);

/** Project files currently on disk. This is the project, not a live preview. */
export function listWorkspaceFiles(root: string, limit = 200): string[] {
  if (!root || !fs.existsSync(root)) return [];
  const found: string[] = [];
  const visit = (dir: string, rel: string, depth: number): void => {
    if (depth > 6 || found.length >= limit) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (found.length >= limit) return;
      if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name) || entry.isSymbolicLink()) continue;
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) visit(path.join(dir, entry.name), child, depth + 1);
      else if (entry.isFile()) found.push(child);
    }
  };
  visit(root, "", 0);
  return found.sort();
}

/**
 * Event history plus files that are still in the workspace directory.
 * A delete is dropped when the file is on disk again. A file on disk with
 * no event is still part of the project.
 */
export function mergeDiskProjectFiles(files: SessionFile[], root: string | null | undefined): SessionFile[] {
  const onDisk = root ? listWorkspaceFiles(root) : [];
  const disk = new Set(onDisk);
  const byPath = new Map<string, SessionFile>();
  for (const file of files) {
    if (!file.path) continue;
    if (file.operation === "delete" && disk.has(file.path)) continue;
    byPath.set(file.path, file);
  }
  for (const rel of onDisk) {
    if (byPath.has(rel)) continue;
    byPath.set(rel, { path: rel, operation: "write", runId: "", at: 0 });
  }
  return [...byPath.values()];
}

/** The published site id in a preview URL: …/api/v1/sites/<id>/ */
export function previewSiteId(url: string): string | null {
  const m = /\/sites\/([^/?#]+)/.exec(url);
  return m ? decodeURIComponent(m[1]!) : null;
}

/** Changed files, artifacts and the newest preview, from the runs' events (oldest run first). */
export function collectSessionOutputs(runs: { id: string; events: AgentEvent[] }[]): { files: SessionFile[]; artifacts: SessionArtifact[]; preview: Omit<SessionPreview, "available"> | null } {
  const files = new Map<string, SessionFile>();
  const artifacts = new Map<string, SessionArtifact>();
  let preview: Omit<SessionPreview, "available"> | null = null;
  for (const run of runs) {
    for (const e of run.events) {
      const at = Number(e.timestamp ?? 0);
      if (e.type === "preview.available" && typeof e.data?.url === "string") {
        preview = { url: e.data.url, runId: run.id, at };
      }
      if (e.type === "artifact.created" && e.data?.artifactId) {
        artifacts.set(String(e.data.artifactId), { artifactId: String(e.data.artifactId), name: String(e.data.name ?? ""), mimeType: e.data.mimeType ? String(e.data.mimeType) : undefined, runId: run.id, at });
      }
      if (e.type !== "tool.completed") continue;
      // The verifier only reads; its rows are not the session's work.
      if (e.data?.verifier) continue;
      const envelope = e.data?.envelope as { status?: string; evidence?: { type?: string; file?: string; operation?: string }[] } | undefined;
      if (!envelope || envelope.status !== "success") continue;
      for (const ev of envelope.evidence ?? []) {
        if (ev.type !== "file" || !ev.file || !FILE_OPS.has(String(ev.operation))) continue;
        files.delete(ev.file); // re-insert: newest last
        files.set(ev.file, { path: ev.file, operation: String(ev.operation), runId: run.id, at });
      }
    }
  }
  return { files: [...files.values()], artifacts: [...artifacts.values()], preview };
}

export async  function sessionState(sessions: WorkSessionStore, store: RunStore, session: WorkSession): Promise<SessionState> {
  const runs = sessionRuns(store, session.runIds).map((r) => ({ id: r.id, events: r.events }));
  const out = collectSessionOutputs(runs);
  const siteId = out.preview ? previewSiteId(out.preview.url) : null;
  const previewAvailable = Boolean(siteId && readPublishedFile(siteId, "index.html"));
  return {
    session,
    runs: summarizeRuns(store, session.runIds),
    activeRunId: session.activeRunId,
    messageCount: (await sessions.messageSummary(session.sessionId)).messageCount,
    files: mergeDiskProjectFiles(out.files, session.projectRoot),
    artifacts: out.artifacts,
    // available means the preview server is still serving. Files can exist when this is false.
    preview: out.preview ? { ...out.preview, available: previewAvailable } : null,
  };
}
