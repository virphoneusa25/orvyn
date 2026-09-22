import React, { useState } from "react";
import type { GroupItem, ToolItem, ToolOp, WorkGroupItem } from "../presentationReducer";
import { openArtifactInContext } from "../contextOpen";
import { FileTypeIcon as BrandFileTypeIcon } from "./FileTypeIcon";
import { IconFile, IconSearch, IconTerminal, IconGlobe, IconWrench } from "./Icons";
import "./ConversationActivity.css";

const LABELS: Record<ToolOp, [string, string]> = {
  read: ["Reading", "Read"], create: ["Writing", "Wrote"], edit: ["Editing", "Edited"],
  delete: ["Deleting", "Deleted"], search: ["Searching", "Searched"], terminal: ["Running command", "Ran command"],
  browser: ["Using browser", "Used browser"], git: ["Checking Git", "Checked Git"],
  test: ["Running tests", "Ran tests"], other: ["Using tool", "Used tool"],
};

/** One icon authority: the brand glyph set (official-style language marks,
 *  local SVGs) with a generic fallback. */
export function FileTypeIcon({ name }: { name: string; ext?: string }) {
  return <BrandFileTypeIcon path={name} />;
}
function ActivityIcon({ op }: { op: ToolOp }) {
  return op === "terminal" || op === "test" ? <IconTerminal size={16} /> : op === "search" ? <IconSearch size={16} /> : op === "browser" ? <IconGlobe size={16} /> : op === "edit" || op === "create" ? <IconWrench size={16} /> : <IconFile size={16} />;
}
export function ToolActivityRow({ item }: { item: ToolItem }) {
  const [expanded, setExpanded] = useState(false);
  const command = item.op === "terminal";
  const state = item.status === "running" ? "In progress" : item.status === "done" ? "Done" : item.status === "stopped" ? "Stopped" : "Failed";
  const verb = item.status === "failed" || item.status === "stopped" ? LABELS[item.op][0] : LABELS[item.op][item.status === "running" ? 0 : 1];
  return <div className={`activity-item activity-${item.status}`}>
    <div className="activity-row" onClick={() => { if (item.op === "browser" && item.ctx) openArtifactInContext({ tab: item.ctx, path: item.fileName ? `${item.path ?? ""}${item.fileName}` : undefined, fileName: item.fileName, op: item.op }); }}>
      {item.fileName ? <FileTypeIcon name={item.fileName} ext={item.ext} /> : <ActivityIcon op={item.op} />}
      <div className="activity-target">
        <span className="activity-verb">{verb}</span>
        {item.fileName ? <><strong>{item.fileName}</strong><span className="activity-path">{item.path}</span></> : !command && <span>{item.label}</span>}
      </div>
      <span className="activity-state">{item.status === "running" && <span className="activity-pulse" />}{state}</span>
      {item.ctx && <button className="activity-link" aria-label={`Open ${item.fileName ?? item.label ?? verb} in ${item.ctx}`} onClick={() => openArtifactInContext({ tab: item.ctx!, path: item.fileName ? `${item.path ?? ""}${item.fileName}` : undefined, fileName: item.fileName, op: item.op })}>Open ↗</button>}
    </div>
    {command && <pre className="activity-command"><span aria-hidden="true">$ </span>{item.label || "Preparing command…"}</pre>}
    {item.detail && <div className="activity-detail">{item.detail}</div>}
    {item.error && <div className="activity-error">{item.error}</div>}
    {item.output && <>
      <button className="activity-link activity-output-toggle" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? "Hide output ▴" : "Show output ▾"}</button>
      {expanded && <><pre className="activity-output">{item.output}</pre>{item.outputTruncated && <div className="activity-detail">Showing the last portion of the output.</div>}</>}
    </>}
  </div>;
}
export function ToolActivityGroup({ group }: { group: GroupItem }) {
  return <details className="activity-group"><summary>{group.items.length} file operations</summary>{group.items.map(item => <ToolActivityRow key={item.key} item={item} />)}</details>;
}
export function WorkGroupRow({ group }: { group: WorkGroupItem }) {
  if (group.type === "inspection") {
    return (
      <details className="activity-group stream-explore" open={group.status === "running" ? true : undefined}>
        <summary>
          <IconSearch size={14} />
          <span className="stream-explore-title">{group.title}{group.summary ? ` · ${group.summary}` : ""}</span>
          <span className="activity-state">{group.status === "running" ? "Running" : group.status === "done" ? "Done" : "Needs attention"}</span>
        </summary>
        {group.items.map((item) => <ToolActivityRow key={item.key} item={item} />)}
      </details>
    );
  }
  if (group.items.length === 1) {
    return <div className="activity-phase">{group.items.map((item) => <ToolActivityRow key={item.key} item={item} />)}</div>;
  }
  return (
    <div className="activity-phase">
      {group.items.map((item) => <ToolActivityRow key={item.key} item={item} />)}
    </div>
  );
}
