import { Icon } from "./Icons";
import { liveStatusLabel, progressRows, terminalRunStatus, type AgentProgressEvent, type ProgressRow } from "../lib/agentProgress";

function typeIcon(row: ProgressRow) {
  if (row.integration === "github") return <Icon.github />;
  if (row.kind === "search") return <Icon.search size={15} />;
  if (row.kind === "command") return <Icon.terminal size={15} />;
  if (row.kind === "file") return <Icon.file size={15} />;
  if (row.kind === "image") return <Icon.image size={15} />;
  if (row.kind === "review") return <Icon.eye size={15} />;
  if (row.kind === "approval") return <Icon.clock size={15} />;
  if (row.kind === "plan") return <Icon.spark size={15} />;
  return <Icon.info size={15} />;
}

function rowIcon(row: ProgressRow) {
  if (row.state === "pending") return <i className="agent-progress__dot" />;
  if (row.state === "failed") return <Icon.x size={15} />;
  return typeIcon(row);
}

function Step({ row, onApprove }: {
  row: ProgressRow;
  onApprove?: (callId: string, approved: boolean, scope?: "once" | "mission" | "session" | "project" | "always") => void;
}) {
  return (
    <li className={`agent-progress__step is-${row.state}`} data-kind={row.kind} data-testid="agent-progress-row">
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
      {row.state === "running" || row.state === "waiting" ? <i className="agent-progress__spinner" aria-label="In progress" /> : null}
      {row.state === "done" ? <span className="agent-progress__done" aria-hidden="true"><Icon.check size={14} /></span> : null}
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
  if (!rows.length && !live) return null;
  const current = [...rows].reverse().find((row) => row.state === "running" || row.state === "waiting");
  const summary = current?.label
    ?? liveStatusLabel(events, status)
    ?? (live ? "Working on your request" : status === "partial" ? "Work completed with remaining items" : status === "cancelled" ? "Work stopped" : "Work completed");

  return (
    <section className="agent-progress agent-progress--flat" aria-label="Agentic Progress Tracking" data-testid="agent-progress" data-status={status}>
      <details open={live}><summary className="agent-progress__live">{summary}</summary>
      <ol className="agent-progress__steps">
        {rows.filter((row) => row.kind !== "file").map((row) => <Step key={row.id} row={row} onApprove={onApprove} />)}
      </ol></details>
    </section>
  );
}
