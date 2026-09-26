import React from "react";
import "./orion-orb.css";

/** Motion of the assistant orb. Selection and copy stay with the caller. */
export type OrbMotion = "thinking" | "tool" | "waiting" | "done" | "error";

export const ORION_ORB_TAG = "ORVYN AI orb";
export const ORION_THINKING_TEXT = "ORION is thinking...";

export function orbMotionForLabel(label: string): OrbMotion {
  const low = label.toLowerCase();
  if (low.includes("error") || low.includes("failed")) return "error";
  if (low.startsWith("waiting") || low.startsWith("stopping") || low.includes("queued")) return "waiting";
  if (low.includes("verif") || low.includes("check") || low.includes("running")) return "tool";
  return "thinking";
}

/**
 * Premium assistant status: a small glowing orb, the ORVYN identity tag,
 * and the live status line. CSS-only so a thinking row does not tick React.
 */
export function OrionThinkingIndicator({
  motion = "thinking",
  message = ORION_THINKING_TEXT,
  detail,
}: {
  motion?: OrbMotion;
  message?: string;
  detail?: React.ReactNode;
}) {
  return (
    <div className={`orion-status orion-status--${motion}`} role="status" data-testid="orion-thinking" data-motion={motion}>
      <span className="orion-orb" aria-hidden="true">
        <span className="orion-orb__bloom" />
        <span className="orion-orb__sphere">
          <span className="orion-orb__swirl" />
          <span className="orion-orb__glint" />
        </span>
      </span>
      <span className="orion-status__tag" data-testid="orion-thinking-tag">{ORION_ORB_TAG}</span>
      <span className="orion-status__msg" data-testid="orion-thinking-text">{message}</span>
      {detail ? <span className="orion-status__detail">{detail}</span> : null}
    </div>
  );
}
