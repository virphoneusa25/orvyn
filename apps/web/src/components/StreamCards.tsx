import { useState } from "react";
import { Icon } from "./Icons";
import { activityLabel, collapseReadFailures, type ChatActivity, type FileEditCard } from "../lib/streamBlocks";

export function EventLog({ items }: { items: ChatActivity[] }) {
  const rows = collapseReadFailures(items);
  if (!rows.length) return null;
  return (
    <ol className="stream-log" data-testid="event-log">
      {rows.map((item) => {
        const pending = item.status === "running" || item.status === "pending";
        const failed = item.status === "failed";
        return (
          <li key={item.id} className={`stream-log__row${pending ? " is-pending" : failed ? " is-failed" : " is-done"}`} data-testid="event-log-row">
            {pending ? <i className="agent-progress__spinner" aria-hidden="true" /> : failed ? <Icon.x size={14} /> : item.kind === "search" ? <Icon.search size={14} /> : item.kind === "read" ? <Icon.globe size={14} /> : <Icon.check size={14} />}
            <span className="stream-log__label">
              {activityLabel(item)}
              {failed && item.error ? <span className="stream-log__error">{item.error}</span> : null}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function statusLabel(status: FileEditCard["status"]): string {
  if (status === "created") return "Created";
  if (status === "deleted") return "Deleted";
  if (status === "moved") return "Moved";
  if (status === "editing") return "Editing";
  return "Modified";
}

export function FileEditAccordion({ edit }: { edit: FileEditCard }) {
  const [open, setOpen] = useState(false);
  const name = edit.path.split("/").pop() || edit.path;
  const hasDiff = edit.diff.length > 0;
  return (
    <div className={`file-edit${edit.pending ? " is-pending" : ""}`} data-testid="file-edit">
      <button type="button" className="file-edit__head" onClick={() => hasDiff && setOpen((v) => !v)} disabled={!hasDiff && !edit.pending} data-testid="file-edit-toggle">
        <Icon.file size={16} />
        <span className="file-edit__path" title={edit.path}><strong>{name}</strong><span>{edit.path}</span></span>
        <span className="file-edit__meta">
          {edit.pending ? <i className="agent-progress__spinner" aria-label="Editing" /> : null}
          <span>{edit.pending ? "Editing" : statusLabel(edit.status)}</span>
          {edit.additions ? <span className="file-edit__add">+{edit.additions}</span> : null}
          {edit.deletions ? <span className="file-edit__del">−{edit.deletions}</span> : null}
        </span>
        {hasDiff ? <span className="file-edit__chevron">{open ? "Hide" : "Expand"}</span> : null}
      </button>
      {open && hasDiff ? (
        <pre className="file-edit__diff" data-testid="file-edit-diff">
          {edit.diff.map((line, i) => (
            <div key={i} className={`file-edit__line is-${line.type === "add" ? "add" : line.type === "remove" ? "remove" : "context"}`}>
              {line.type === "add" ? "+" : line.type === "remove" ? "−" : " "} {line.content}
            </div>
          ))}
        </pre>
      ) : null}
    </div>
  );
}

export function FileEditList({ edits }: { edits: FileEditCard[] }) {
  if (!edits.length) return null;
  return (
    <div className="file-edit-list">
      {edits.map((edit) => <FileEditAccordion key={edit.path} edit={edit} />)}
    </div>
  );
}
