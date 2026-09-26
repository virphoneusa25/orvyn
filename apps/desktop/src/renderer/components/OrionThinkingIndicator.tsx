import React from "react";
import { OrionPlasmaOrb } from "./OrionPlasmaOrb";
import "./orion-plasma-orb.css";

/** Motion of the assistant orb. Selection and copy stay with the caller. */
export type OrbMotion = "thinking" | "tool" | "waiting" | "done" | "error";

export const ORION_THINKING_TEXT = "ORION is thinking...";
export const ORION_WORKING_TEXT = "ORION is working...";
export const ORION_WAITING_TEXT = "Waiting for your approval";

export function orbMotionForLabel(label: string): OrbMotion {
  const low = label.toLowerCase();
  if (low.includes("error") || low.includes("failed")) return "error";
  if (low.startsWith("waiting") || low.startsWith("stopping") || low.includes("queued")) return "waiting";
  if (low.includes("verif") || low.includes("check") || low.includes("running") || low.includes("writing") || low.includes("creating") || low.includes("updating")) return "tool";
  return "thinking";
}

function genericThinking(message: string): boolean {
  const text = message.trim();
  return text.length === 0 || text === ORION_THINKING_TEXT || /^thinking[.…]?$/i.test(text);
}

function StatusLine({ motion, message }: { motion: OrbMotion; message: string }) {
  if (motion === "tool" && genericThinking(message)) {
    return (
      <>
        <strong className="orion-status__name">ORION</strong> is working...
      </>
    );
  }
  if (motion === "waiting") {
    return <>{genericThinking(message) ? ORION_WAITING_TEXT : message}</>;
  }
  if (motion === "error") {
    return <>{genericThinking(message) ? "Something went wrong" : message}</>;
  }
  if (motion === "tool" || (motion === "done" && !genericThinking(message))) {
    return <>{message}</>;
  }
  return (
    <>
      <strong className="orion-status__name">ORION</strong> is thinking...
    </>
  );
}

/**
 * Chat status: the plasma orb, then the live line. No identity pill.
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
      <OrionPlasmaOrb motion={motion} />
      <span className="orion-status__msg" data-testid="orion-thinking-text">
        <StatusLine motion={motion} message={message} />
      </span>
      {detail ? <span className="orion-status__detail">{detail}</span> : null}
    </div>
  );
}
