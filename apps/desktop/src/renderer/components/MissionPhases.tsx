import React from "react";
import type { MissionView } from "../missionPhases";

const LABEL: Record<MissionView["status"], string> = {
  running: "In progress",
  verified: "Verified",
  completed: "Completed",
  attention: "Needs attention",
};

/** The site's mission timeline, driven by the real run. */
export function MissionPhases({ view }: { view: MissionView }) {
  return (
    <div className={`mission-phases mission-phases--${view.status}`} aria-label="Mission progress">
      <ol className="mission-phases__list">
        {view.phases.map((p, i) => (
          <li key={p.name} className={`mission-phases__item is-${p.state}`} aria-current={p.state === "active" ? "step" : undefined}>
            <span className="mission-phases__num">{p.state === "done" ? "✓" : String(i + 1).padStart(2, "0")}</span>
            <span className="mission-phases__name">{p.name}</span>
          </li>
        ))}
      </ol>
      <span className={`mission-phases__pill is-${view.status}`}>
        {view.status === "running" && <i className="tool-line__spin" aria-hidden="true" />}
        {LABEL[view.status]}
      </span>
    </div>
  );
}
