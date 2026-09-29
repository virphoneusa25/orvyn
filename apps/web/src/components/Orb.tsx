import orbVideo from "../assets/orb.webm";
import icon from "../assets/icon.png";

/** The ORVYN orb (the same animation as ORVYN Desktop's onboarding). Muted, looped, decorative. */
export function Orb({ className }: { className?: string }) {
  const reduce = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  if (reduce) return <img className={className} src={icon} alt="" aria-hidden="true" />;
  return <video className={className} src={orbVideo} poster={icon} autoPlay muted loop playsInline aria-hidden="true" />;
}
