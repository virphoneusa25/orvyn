// The conversation's project at a glance: where it works, what it changed,
// and its live preview. Reopening a chat shows this, so the user continues
// the same project (files and preview included), not a blank stream.

import React, { useEffect, useState } from "react";
import { fetchSessionState, type SessionStateView } from "../sessionsApi";
import { openArtifactInContext } from "../contextOpen";

export function SessionRestoreCard({ sessionId, refreshKey }: { sessionId: string | null | undefined; refreshKey?: string }) {
  const [state, setState] = useState<SessionStateView | null>(null);
  useEffect(() => {
    if (!sessionId) { setState(null); return; }
    let alive = true;
    void fetchSessionState(sessionId).then((s) => { if (alive) setState(s); });
    return () => { alive = false; };
  }, [sessionId, refreshKey]);
  if (!state || !state.runs.length || (!state.files.length && !state.preview && !state.artifacts.length)) return null;
  const root = state.session.projectRoot;
  const project = root ? root.replace(/[\\/]+$/, "").split(/[\\/]/).pop() : "Cloud workspace";
  const files = state.files.filter((f) => f.operation !== "delete");
  return (
    <div className="session-restore" data-testid="session-restore" data-project-root={root ?? ""}>
      <div className="session-restore__head">
        <span className="session-restore__project" title={root ?? undefined}>{project}</span>
        <span className="session-restore__meta">
          {state.runs.length} {state.runs.length === 1 ? "run" : "runs"} · {files.length} {files.length === 1 ? "file" : "files"}
        </span>
        {state.preview && (
          state.preview.available
            ? <button className="session-restore__preview" data-testid="session-preview" data-url={state.preview.url}
                onClick={() => openArtifactInContext({ tab: "preview", url: state.preview!.url })}>Open preview</button>
            : <span className="session-restore__meta">Preview no longer available</span>
        )}
      </div>
      {files.length > 0 && (
        <div className="session-restore__files">
          {files.slice(-12).map((f) => {
            const name = f.path.split("/").pop() ?? f.path;
            return (
              <button key={f.path} className="session-restore__file" data-testid="session-file" title={`${f.operation} · ${f.path}`}
                onClick={() => openArtifactInContext({ tab: "files", path: f.path, fileName: name, op: f.operation })}>
                {f.path}
              </button>
            );
          })}
          {files.length > 12 && <span className="session-restore__meta">+{files.length - 12} more</span>}
        </div>
      )}
    </div>
  );
}
