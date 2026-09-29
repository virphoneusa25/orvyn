import React from "react";
import orbGif from "./orion-orb.gif";
import "./orion-plasma-orb.css";

/**
 * The ORVYN orb — the user's ORB_Orvyn.gif (148 frames, 30ms, seamless
 * loop), rendered as an <img>. The GIF animates in the image decoder and
 * compositor, never on the main thread, and `mix-blend-mode: screen` makes
 * its black field disappear against the app's dark background so only the
 * plasma shows. Motion states keep the same grammar as before: active
 * states play the gif; done/error keep their flash/fade.
 */
export function OrionPlasmaOrb({ motion = "thinking" }: { motion?: "thinking" | "tool" | "waiting" | "done" | "error" }) {
  return (
    <span className={`opo opo--${motion}`} aria-hidden="true" data-testid="orion-plasma-orb">
      <img className="opo__gif" src={orbGif} alt="" draggable={false} />
    </span>
  );
}
