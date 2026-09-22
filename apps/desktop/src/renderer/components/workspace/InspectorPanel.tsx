import React, { useState } from "react";
import type { AgentEvent } from "../AgentActivityList";
import type { AgentWorkspaceDerived, InspectorTab, ReviewSummary } from "../../agentWorkspaceModel";
import { DocumentsPanel } from "../DocumentsPanel";
import { MissionPlan } from "../MissionPlan";
import { IconClose, IconMore, IconPin } from "../Icons";
import { DiffInspector } from "./DiffInspector";
import { FilesInspector } from "./FilesInspector";
import { ReviewInspector } from "./ReviewInspector";
import { TerminalInspector } from "./TerminalInspector";
import { iconBtn, tabBtn } from "./workspaceChrome";

const PRIMARY: { id: InspectorTab; label: string }[] = [
  { id: "files", label: "Files" },
  { id: "diff", label: "Diff" },
  { id: "terminal", label: "Terminal" },
  { id: "review", label: "Review" },
];

export function InspectorPanel({
  derived,
  events,
  tab,
  runStatus,
  runId,
  projectRoot,
  focus,
  selectedDiff,
  review,
  onSelectTab,
  onSelectDiff,
  onOpenFile,
  onPreviewArtifact,
  pinned,
  onClose,
  onTogglePin,
}: {
  derived: AgentWorkspaceDerived;
  events: AgentEvent[];
  tab: InspectorTab;
  runStatus: string;
  runId?: string;
  projectRoot: string | null;
  focus?: { path?: string; fileName?: string } | null;
  selectedDiff?: string | null;
  review: ReviewSummary;
  onSelectTab: (tab: InspectorTab) => void;
  onSelectDiff: (path: string) => void;
  onOpenFile: (path: string) => void;
  onPreviewArtifact?: (path: string) => void;
  pinned: boolean;
  onClose: () => void;
  onTogglePin: () => void;
}) {
  const [more, setMore] = useState(false);

  return (
    <div style={{ height: "100%", minWidth: 0, display: "flex", flexDirection: "column", background: "var(--orvyn-surface-1)", borderLeft: "1px solid var(--orvyn-border-soft)" }}>
      <div style={{ display: "flex", alignItems: "center", height: 32, borderBottom: "1px solid var(--orvyn-border-soft)", padding: "0 4px", flexShrink: 0 }}>
        {PRIMARY.map((t) => (
          <button key={t.id} onClick={() => onSelectTab(t.id)} style={tabBtn(tab === t.id)}>
            {t.label}
          </button>
        ))}
        <span style={{ marginLeft: "auto", position: "relative", display: "inline-flex", alignItems: "center" }}>
          <button title={pinned ? "Unpin Inspector" : "Pin Inspector"} style={iconBtn(pinned)} onClick={onTogglePin}>
            <IconPin size={13} />
          </button>
          <button title="Close Inspector" style={iconBtn()} onClick={onClose}>
            <IconClose size={13} />
          </button>
          <button title="Plan, Docs, and more" style={iconBtn(more || tab === "plan" || tab === "docs")} onClick={() => setMore((v) => !v)}>
            <IconMore size={14} />
          </button>
          {more && (
            <div style={{ position: "absolute", right: 0, top: 28, zIndex: 20, minWidth: 120, background: "var(--orvyn-surface-2)", border: "1px solid var(--orvyn-border)", borderRadius: 8, padding: 4 }}>
              <button style={overflowItem()} onClick={() => { onSelectTab("plan"); setMore(false); }}>Plan</button>
              <button style={overflowItem()} onClick={() => { onSelectTab("docs"); setMore(false); }}>Docs</button>
            </div>
          )}
        </span>
      </div>
      <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
        {tab === "files" && (
          <FilesInspector
            files={derived.files}
            artifacts={derived.artifacts}
            projectRoot={projectRoot}
            focus={focus}
            activePath={selectedDiff ?? derived.activity?.file}
            onOpenFile={onOpenFile}
            onPreviewArtifact={onPreviewArtifact}
          />
        )}
        {tab === "diff" && (
          <DiffInspector diffs={derived.diffs} focus={focus} selectedPath={selectedDiff ?? derived.activity?.file} onSelect={onSelectDiff} />
        )}
        {tab === "terminal" && <TerminalInspector events={events} />}
        {tab === "review" && (
          <ReviewInspector
            runId={runId}
            summary={review}
            onOpenDiff={() => onSelectTab("diff")}
            onOpenTerminal={() => onSelectTab("terminal")}
          />
        )}
        {tab === "plan" && (
          <div style={{ flex: 1, overflowY: "auto", padding: 10 }}>
            <MissionPlan events={events} status={runStatus} />
          </div>
        )}
        {tab === "docs" && <DocumentsPanel projectRoot={projectRoot} revision={derived.artifacts.length} />}
      </div>
    </div>
  );
}

function overflowItem(): React.CSSProperties {
  return {
    display: "block",
    width: "100%",
    background: "transparent",
    border: "none",
    color: "var(--orvyn-text-secondary)",
    textAlign: "left",
    fontSize: 12,
    padding: "6px 8px",
    cursor: "pointer",
  };
}
