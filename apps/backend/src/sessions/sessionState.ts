// apps/backend/src/sessions/sessionState.ts
//
// Everything a WorkSession produced, gathered from its runs: the project it
// works in, its runs, the files it changed, the artifacts it made and the
// newest live preview. Reopening a conversation restores this whole picture,
// so the user continues the same project instead of starting over.

import type { AgentEvent, RunStore } from "../agent/events";
import { summarizeRuns, sessionRuns, type ThreadRunSummary } from "../agent/runThread";
import { readPublishedFile } from "../agent/sitePreview";
import type { WorkSession, WorkSessionStore } from "./WorkSessionStore";

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

export function sessionState(sessions: WorkSessionStore, store: RunStore, session: WorkSession): SessionState {
  const runs = sessionRuns(store, session.runIds).map((r) => ({ id: r.id, events: r.events }));
  const out = collectSessionOutputs(runs);
  const siteId = out.preview ? previewSiteId(out.preview.url) : null;
  return {
    session,
    runs: summarizeRuns(store, session.runIds),
    activeRunId: session.activeRunId,
    messageCount: sessions.messageSummary(session.sessionId).messageCount,
    files: out.files,
    artifacts: out.artifacts,
    preview: out.preview ? { ...out.preview, available: Boolean(siteId && readPublishedFile(siteId, "index.html")) } : null,
  };
}
