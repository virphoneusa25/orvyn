import { useEffect, useId, useState } from "react";
import { Icon } from "./Icons";
import { liveStatusLabel, progressRows, terminalRunStatus, type AgentProgressEvent, type ProgressRow } from "../lib/agentProgress";

function rowIcon(row: ProgressRow) {
  if (row.state === "pending") return <i className="agent-progress__dot" />;
  if (row.integration === "github") return <Icon.github />;
  if (row.state === "done") return <Icon.check size={15} />;
  if (row.state === "failed") return <Icon.x size={15} />;
  if (row.state === "waiting") return <Icon.clock size={15} />;
  if (row.kind === "file") return <Icon.pen size={15} />;
  if (row.kind === "command") return <Icon.terminal size={15} />;
  if (row.kind === "search") return <Icon.search size={15} />;
  if (row.kind === "review") return <Icon.check size={15} />;
  return <Icon.spark size={15} />;
}

function Step({ row, onApprove }: {
  row: ProgressRow;
  onApprove?: (callId: string, approved: boolean, scope?: "once" | "mission" | "session" | "project" | "always") => void;
}) {
  return (
    <li className={`agent-progress__step is-${row.state}${row.nested ? " is-nested" : ""}`} data-kind={row.kind}>
      <span className="agent-progress__icon" aria-hidden="true">{rowIcon(row)}</span>
      <span className="agent-progress__body">
        <span className="agent-progress__label">{row.label}</span>
        {row.detail ? <span className="agent-progress__detail">{row.detail}</span> : null}
        {row.state === "waiting" && row.approvalCallId && onApprove ? (
          <span className="agent-progress__actions">
            <button className="btn btn--sm btn--primary" onClick={() => onApprove(row.approvalCallId!, true, "once")}>Allow Once</button>
            <button className="btn btn--sm" onClick={() => onApprove(row.approvalCallId!, true, "session")}>This Session</button>
            <button className="btn btn--sm" onClick={() => onApprove(row.approvalCallId!, true, "project")}>This Project</button>
            <button className="btn btn--sm" onClick={() => onApprove(row.approvalCallId!, true, "always")}>Always Allow</button>
            <button className="btn btn--sm" onClick={() => onApprove(row.approvalCallId!, false)}>Deny</button>
          </span>
        ) : null}
      </span>
      {row.state === "running" ? <i className="agent-progress__spinner" aria-label="In progress" /> : null}
    </li>
  );
}

export function AgentProgress({ events, status, onApprove }: {
  events: AgentProgressEvent[];
  status: string;
  onApprove?: (callId: string, approved: boolean, scope?: "once" | "mission" | "session" | "project" | "always") => void;
}) {
  const rows = progressRows(events, status);
  const live = !terminalRunStatus(status);
  const panelId = useId();
  const [expanded, setExpanded] = useState(live);
  useEffect(() => { setExpanded(live); }, [live]);
  if (!rows.length && !live) return null;
  const current = [...rows].reverse().find((row) => row.state === "running" || row.state === "waiting");
  const stages = rows.filter((row) => !row.nested);
  const doneCount = stages.filter((row) => row.state === "done").length;
  const summary = current?.label
    ?? liveStatusLabel(events, status)
    ?? (live ? "Working on your request" : status === "partial" ? "Work completed with remaining items" : status === "cancelled" ? "Work stopped" : "Work completed");

  return (
    <section className={`agent-progress${expanded ? " is-open" : ""}`} aria-label="Agentic Progress Tracking" data-testid="agent-progress" data-status={status}>
      <button
        type="button"
        className="agent-progress__head"
        aria-expanded={expanded}
        aria-controls={panelId}
        onClick={() => setExpanded((value) => !value)}
        data-testid="agent-progress-toggle"
      >
        <span className="agent-progress__head-icon">{live ? <i className="agent-progress__pulse" /> : <Icon.check size={15} />}</span>
        <span className="agent-progress__summary">{summary}</span>
        <span className="agent-progress__count">{stages.length ? `${doneCount}/${stages.length}` : "Live"}</span>
        <span className="agent-progress__chevron" aria-hidden="true"><Icon.down size={15} /></span>
      </button>
      {expanded ? (
        <ol id={panelId} className="agent-progress__steps">
          {rows.map((row) => <Step key={row.id} row={row} onApprove={onApprove} />)}
        </ol>
      ) : null}
    </section>
  );
}
