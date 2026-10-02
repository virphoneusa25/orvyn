import React, { useState } from "react";
import type { MissionDetailData } from "./types";

type RememberedScope = "once" | "session" | "project" | "always";

export function MissionDetail({ mission, onBack, onApprove, onDeny, onReply, onStop }: {
  mission: MissionDetailData;
  onBack: () => void;
  onApprove: (id: string, scope: RememberedScope) => void;
  onDeny: (id: string) => void;
  onReply: (text: string) => void;
  onStop?: () => void;
}) {
  const [text, setText] = useState("");
  const scopes: { scope: RememberedScope; label: string }[] = [
    { scope: "once", label: "Allow Once" },
    { scope: "session", label: "This Session" },
    { scope: "project", label: "This Project" },
    { scope: "always", label: "Always Allow" },
  ];

  return (
    <div className="ov-detail">
      <header className="ov-detail-head">
        <button onClick={onBack}>‹ Missions</button>
        <div><h1>{mission.title}</h1><small>{mission.id} · {mission.agent ?? "ORION"} · {mission.project ?? "project"}</small></div>
        <span className="ov-status approval">{mission.status}</span>
        <button className="ov-danger" onClick={onStop}>Cancel mission</button>
      </header>
      <div className="ov-detail-grid">
        <aside className="ov-plan">
          <h3>Plan</h3>
          {mission.plan.map((item, i) => (
            <div className={`ov-plan-step ${item.state}`} key={item.id}>
              <i>{item.state === "done" ? "✓" : i + 1}</i>
              <span><strong>{item.title}</strong><small>{item.detail}</small></span>
            </div>
          ))}
        </aside>
        <section className="ov-thread">
          {mission.events.map((event) => <article className="ov-event" key={event.id}><strong>{event.title}</strong>{event.body && <p>{event.body}</p>}</article>)}
          {mission.approval && (
            <article className="ov-approval">
              <header>🛡 Approve action <span>{mission.approval.location}</span></header>
              <code>{mission.approval.command}</code>
              {mission.approval.details && <small>{mission.approval.details.join(" · ")}</small>}
              <footer>
                {scopes.map(({ scope, label }) => <button key={scope} className={scope === "once" ? "ov-primary" : undefined} onClick={() => onApprove(mission.approval!.id, scope)}>{label}</button>)}
                <button onClick={() => onDeny(mission.approval!.id)}>Deny</button>
              </footer>
              <small>Destructive actions always ask again.</small>
            </article>
          )}
          <div className="ov-reply"><input value={text} onChange={(e) => setText(e.target.value)} placeholder="Reply to ORION, or add instructions…" /><button onClick={() => { if (text.trim()) { onReply(text.trim()); setText(""); } }}>↑</button></div>
        </section>
        <aside className="ov-inspector">
          <h3>Permissions</h3>
          {mission.permissions?.map((item) => <div className="ov-kv" key={item.label}><span>{item.label}</span><b>{item.value}</b></div>)}
          <h3>Budget &amp; model</h3>
          {mission.usage ? <><div className="ov-kv"><span>Model</span><b>{mission.usage.modelId ?? "Auto"}</b></div><div className="ov-kv"><span>Tokens</span><b>{(mission.usage.promptTokens + mission.usage.completionTokens).toLocaleString()}</b></div><div className="ov-kv"><span>Turns</span><b>{mission.usage.turns}</b></div></> : <p>No usage reported yet.</p>}
          <h3>Files touched</h3>
          {mission.files?.map((file) => <div className="ov-file" key={file.path}><span>{file.action}</span> {file.path}</div>)}
          <h3>Run log</h3>
          {mission.runLog?.map((item) => <div className="ov-kv" key={item.sequence}><span>#{item.sequence} {item.type}</span><b>{new Date(item.at).toLocaleTimeString()}</b></div>)}
          <h3>Deliverable</h3><p>{mission.deliverable ?? "Mission output and verification evidence will appear here."}</p>
        </aside>
      </div>
    </div>
  );
}
