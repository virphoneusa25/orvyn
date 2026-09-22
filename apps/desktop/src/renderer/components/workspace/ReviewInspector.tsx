import React, { type CSSProperties } from "react";
import { ReviewPanel } from "../ReviewPanel";
import type { ReviewSummary } from "../../agentWorkspaceModel";
import { emptyBody, emptyTitle } from "./workspaceChrome";

export function ReviewInspector({
  runId,
  summary,
  onOpenDiff,
  onOpenTerminal,
  onOpenArtifact,
}: {
  runId?: string;
  summary: ReviewSummary;
  onOpenDiff: () => void;
  onOpenTerminal: () => void;
  onOpenArtifact?: () => void;
}) {
  const empty = !summary.completed && summary.filesChanged === 0 && summary.testsPassed === 0 && summary.artifacts === 0;
  return (
    <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}>
      {empty ? (
        <div style={{ padding: 20, textAlign: "center" }}>
          <div style={emptyTitle()}>Nothing to review yet</div>
          <div style={{ ...emptyBody(), margin: "8px auto 0" }}>A summary will appear when work is ready.</div>
        </div>
      ) : (
        <div style={{ padding: "10px 12px", borderBottom: "1px solid var(--orvyn-border-soft)", display: "flex", flexDirection: "column", gap: 6 }}>
          <button onClick={onOpenDiff} style={linkRow()}>
            {summary.filesChanged} files changed · <span style={{ color: "var(--orvyn-green)" }}>+{summary.additions}</span>{" "}
            <span style={{ color: "var(--orvyn-red)" }}>−{summary.deletions}</span>
          </button>
          {(summary.testsPassed > 0 || summary.testsFailed > 0) && (
            <button onClick={onOpenTerminal} style={linkRow()}>
              {summary.testsFailed === 0 ? "✓" : "✕"} {summary.testsPassed} tests passed
              {summary.testsFailed ? ` · ${summary.testsFailed} failed` : ""}
            </button>
          )}
          {summary.buildPassed != null && (
            <button onClick={onOpenTerminal} style={linkRow()}>
              {summary.buildPassed ? "✓ Build passed" : "✕ Build failed"}
            </button>
          )}
          {summary.warnings > 0 && <div style={{ fontSize: 12, color: "var(--orvyn-yellow)" }}>⚠ {summary.warnings} warning{summary.warnings === 1 ? "" : "s"}</div>}
          {summary.artifacts > 0 && (
            <button onClick={onOpenArtifact} style={linkRow()}>
              {summary.artifacts} artifact{summary.artifacts === 1 ? "" : "s"}
            </button>
          )}
        </div>
      )}
      <div style={{ flex: 1, minHeight: 0, overflow: "auto" }}>
        <ReviewPanel runId={runId} />
      </div>
    </div>
  );
}

function linkRow(): CSSProperties {
  return {
    background: "transparent",
    border: "none",
    color: "var(--orvyn-text)",
    textAlign: "left",
    fontSize: 12.5,
    padding: 0,
    cursor: "pointer",
  };
}
