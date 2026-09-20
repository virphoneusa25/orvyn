// apps/desktop/src/renderer/components/redesign/MissionDetail.tsx
// Mission detail: plan timeline (left), activity stream with the approval
// gate (center), permissions / budget / files / deliverable (right).
// Presentational — pass mission data and handlers in.
import React, { useState } from "react";
import { Icon } from "./icons";
import type { ActivityItem, ApprovalRequest, MissionDetailData } from "./types";
import orvynMark from "../../assets/orvyn-mark.png";

export interface MissionDetailProps {
  mission: MissionDetailData;
  onBack: () => void;
  onPause?: () => void;
  onCancel?: () => void;
  onEditPlan?: () => void;
  onViewTool?: (toolId: string) => void;
  onApprove?: (requestId: string, remember: boolean) => void;
  onDeny?: (requestId: string) => void;
  onEditCommand?: (requestId: string) => void;
  onReply?: (text: string) => void;
  onOpenLog?: () => void;
}

const PERMISSION_LABEL = { allowed: "Allowed", ask: "Ask", off: "Off" } as const;

export function MissionDetail(props: MissionDetailProps) {
  const { mission } = props;
  const [reply, setReply] = useState("");
  const done = mission.steps.filter((s) => s.state === "done").length;

  const sendReply = () => {
    const t = reply.trim();
    if (!t) return;
    props.onReply?.(t);
    setReply("");
  };

  return (
    <div className="ov-column">
      <header className="ov-mission-head">
        <button type="button" className="ov-back" onClick={props.onBack}>
          <Icon name="chevronLeft" size={14} strokeWidth={2} />
          Missions
        </button>
        <div className="ov-mission-head__row">
          <h1>{mission.title}</h1>
          <span className={`ov-badge ov-badge--${mission.tone}`}>
            <span className="ov-dot ov-dot--sm" />
            {mission.label}
          </span>
          <div className="ov-mission-head__actions">
            <button type="button" className="ov-btn" onClick={props.onPause}>
              Pause
            </button>
            <button type="button" className="ov-btn ov-btn--danger" onClick={props.onCancel}>
              Cancel mission
            </button>
          </div>
        </div>
        <div className="ov-mission-head__meta">
          {mission.meta.map((m) => (
            <span key={m}>{m}</span>
          ))}
        </div>
      </header>

      <div className="ov-mission-grid">
        {/* ── Plan ── */}
        <aside className="ov-plan" aria-labelledby="ov-plan-h">
          <div className="ov-plan__head">
            <h2 id="ov-plan-h" className="ov-panel-title">
              Plan
            </h2>
            <span className="ov-setup__count">
              {done} / {mission.steps.length}
            </span>
          </div>
          <ol>
            {mission.steps.map((s) => (
              <li key={s.id} className={`ov-step ov-step--${s.state}`} aria-current={s.state === "current" ? "step" : undefined}>
                <div className="ov-step__track">
                  <span className="ov-step__dot">{s.state === "done" ? "✓" : ""}</span>
                  <span className="ov-step__line" />
                </div>
                <div className="ov-step__body">
                  <span className="ov-step__title">{s.title}</span>
                  <span className="ov-step__detail">{s.detail}</span>
                </div>
              </li>
            ))}
          </ol>
          <button type="button" className="ov-plan__edit" onClick={props.onEditPlan}>
            Edit plan
          </button>
        </aside>

        {/* ── Activity ── */}
        <section className="ov-activity" aria-label="Activity">
          <div className="ov-activity__stream">
            {mission.activity.map((item) => (
              <ActivityEntry key={item.id} item={item} {...props} />
            ))}
          </div>
          <div className="ov-reply-wrap">
            <div className="ov-reply">
              <label htmlFor="ov-reply" className="ov-sr-only">
                Reply to the agent
              </label>
              <input
                id="ov-reply"
                type="text"
                value={reply}
                onChange={(e) => setReply(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && sendReply()}
                placeholder="Reply to Astra, or add instructions…"
              />
              <button type="button" className="ov-icon-btn" aria-label="Send" onClick={sendReply}>
                <Icon name="arrowUp" size={15} strokeWidth={2} />
              </button>
            </div>
          </div>
        </section>

        {/* ── Context ── */}
        <aside className="ov-context" aria-label="Mission context">
          <div className="ov-context__block">
            <h2 className="ov-panel-title">Permissions</h2>
            {mission.permissions.map((p) => (
              <div className="ov-perm" key={p.name}>
                <span>{p.name}</span>
                <span className={`ov-perm__level ov-perm__level--${p.level}`}>{PERMISSION_LABEL[p.level]}</span>
              </div>
            ))}
          </div>

          <div className="ov-context__block">
            <h2 className="ov-panel-title">Budget</h2>
            <div className="ov-budget">
              <span>{mission.budget.usedLabel}</span>
              <span>of {mission.budget.capLabel}</span>
            </div>
            <div className="ov-meter">
              <div style={{ width: `${Math.min(100, Math.max(0, mission.budget.percent))}%` }} />
            </div>
          </div>

          <div className="ov-context__block">
            <h2 className="ov-panel-title">Files touched</h2>
            {mission.files.map((f) => (
              <div className="ov-file" key={f.path + f.op}>
                <span className={`ov-file__op${f.op === "write" ? " ov-file__op--write" : ""}`}>{f.op}</span>
                {f.path}
              </div>
            ))}
          </div>

          <div className="ov-context__block">
            <h2 className="ov-panel-title">Deliverable</h2>
            <p>{mission.deliverable}</p>
          </div>

          <div className="ov-log-card">
            <strong>Run log</strong>
            <span>Every tool call, command, and output is recorded and replayable.</span>
            <button type="button" onClick={props.onOpenLog}>
              Open log →
            </button>
          </div>
        </aside>
      </div>
    </div>
  );
}

function ActivityEntry({ item, ...props }: { item: ActivityItem } & MissionDetailProps) {
  if (item.kind === "user") {
    return (
      <div className="ov-msg ov-msg--user">
        <span className="ov-msg__avatar">{item.initial}</span>
        <div className="ov-msg__body" style={{ gap: 4 }}>
          <span className="ov-msg__who">
            {item.author} · {item.time}
          </span>
          <p className="ov-msg__text">{item.text}</p>
        </div>
      </div>
    );
  }

  if (item.kind === "agent") {
    return (
      <div className="ov-msg">
        <span className="ov-msg__avatar ov-msg__avatar--agent">
          <img src={orvynMark} alt="" />
        </span>
        <div className="ov-msg__body">
          <span className="ov-msg__who">
            {item.agent} · {item.time}
          </span>
          {item.tools?.map((t) => (
            <div className="ov-tool" key={t.id}>
              <span style={{ color: t.ok ? "var(--ov-green)" : "var(--ov-red)", display: "flex" }}>
                <Icon name="check" size={14} strokeWidth={2.2} />
              </span>
              <span className="ov-tool__verb">{t.verb}</span>
              <code>{t.target}</code>
              <button type="button" onClick={() => props.onViewTool?.(t.id)}>
                View
              </button>
            </div>
          ))}
          <p className="ov-msg__text">{item.text}</p>
          {item.approval && <ApprovalCard request={item.approval} {...props} />}
        </div>
      </div>
    );
  }

  // Standalone approval cards render inside the agent's column, aligned with its text.
  return (
    <div className="ov-msg">
      <span style={{ width: 28, flexShrink: 0 }} />
      <div className="ov-msg__body">
        <ApprovalCard request={item.request} {...props} />
      </div>
    </div>
  );
}

function ApprovalCard({ request, onApprove, onDeny, onEditCommand }: { request: ApprovalRequest } & MissionDetailProps) {
  const [remember, setRemember] = useState(false);
  const checkId = `ov-remember-${request.id}`;
  return (
    <div className="ov-approval">
      <div className="ov-approval__head">
        <span style={{ color: "var(--ov-teal)", display: "flex" }}>
          <Icon name="shield" size={16} strokeWidth={1.8} />
        </span>
        <strong>Approve command</strong>
        <span className="ov-approval__where">Runs on {request.runsOn}</span>
      </div>
      <div className="ov-approval__body">
        <pre>
          <span>{request.cwd} $</span> {request.command}
        </pre>
        <div className="ov-approval__effects">
          {request.effects.map((e) => (
            <span key={e}>{e}</span>
          ))}
        </div>
      </div>
      <div className="ov-approval__foot">
        <input id={checkId} type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
        <label htmlFor={checkId}>{request.rememberLabel}</label>
        <div className="ov-approval__buttons">
          <button type="button" className="ov-btn" onClick={() => onDeny?.(request.id)}>
            Deny
          </button>
          <button type="button" className="ov-btn" onClick={() => onEditCommand?.(request.id)}>
            Edit
          </button>
          <button type="button" className="ov-btn ov-btn--primary" onClick={() => onApprove?.(request.id, remember)}>
            Approve &amp; run
          </button>
        </div>
      </div>
    </div>
  );
}
