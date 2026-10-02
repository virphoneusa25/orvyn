import { useEffect, useState } from "react";
import { Icon } from "./Icons";
import { progressRows, terminalRunStatus, type AgentProgressEvent, type ProgressRow } from "../lib/agentProgress";

function rowIcon(row: ProgressRow) {
  if (row.state === "done") return <Icon.check size={15} />;
  if (row.state === "failed") return <Icon.x size={15} />;
  if (row.state === "waiting") return <Icon.clock size={15} />;
  if (row.kind === "file") return <Icon.pen size={15} />;
  if (row.kind === "command") return <Icon.terminal size={15} />;
  if (row.kind === "search") return <Icon.search size={15} />;
  if (row.kind === "review") return <Icon.check size={15} />;
  return <Icon.spark size={15} />;
}

export function AgentProgress({ events, status, onApprove }: {
  events: AgentProgressEvent[];
  status: string;
  onApprove?: (callId: string, approved: boolean) => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const rows = progressRows(events);
  const live = !terminalRunStatus(status);
  useEffect(() => { if (live) setExpanded(true); }, [live]);
  if (!rows.length && !live) return null;
  const current = [...rows].reverse().find((row) => row.state === "running" || row.state === "waiting");
  const summary = current?.label ?? (live ? "Working on your request" : status === "completed" ? "Work completed" : status === "partial" ? "Work completed with remaining items" : status === "cancelled" ? "Work stopped" : "Work needs attention");

  return (
    <section className="agent-progress" aria-label="Agentic Progress Tracking" data-testid="agent-progress" data-status={status}>
      <button className="agent-progress__head" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)} data-testid="agent-progress-toggle">
        <span className="agent-progress__head-icon">{live ? <i className="agent-progress__pulse" /> : status === "completed" ? <Icon.check size={15} /> : <Icon.layers size={15} />}</span>
        <span className="agent-progress__summary">{summary}</span>
        <span className="agent-progress__count">{rows.length ? `${rows.filter((row) => row.state === "done").length}/${rows.length}` : "Starting"}</span>
        <Icon.down size={15} />
      </button>
      {expanded ? (
        <ol className="agent-progress__steps">
          {rows.map((row) => (
            <li key={row.id} className={`agent-progress__step is-${row.state}`} data-kind={row.kind}>
              <span className="agent-progress__icon" aria-hidden="true">{rowIcon(row)}</span>
              <span className="agent-progress__body">
                <span className="agent-progress__label">{row.label}</span>
                {row.detail ? <span className="agent-progress__detail">{row.detail}</span> : null}
                {row.state === "waiting" && row.approvalCallId && onApprove ? (
                  <span className="agent-progress__actions">
                    <button className="btn btn--sm btn--primary" onClick={() => onApprove(row.approvalCallId!, true)}>Approve</button>
                    <button className="btn btn--sm" onClick={() => onApprove(row.approvalCallId!, false)}>Deny</button>
                  </span>
                ) : null}
              </span>
              {row.state === "running" ? <i className="agent-progress__spinner" aria-label="In progress" /> : null}
            </li>
          ))}
          {live && !current ? <li className="agent-progress__thinking"><span className="typing" aria-label="ORVYN is working"><i /><i /><i /></span><span>Working through the next step…</span></li> : null}
        </ol>
      ) : null}
    </section>
  );
}
