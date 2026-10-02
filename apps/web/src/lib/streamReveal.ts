import { useEffect, useState } from "react";

/** Catch the displayed reply up to the SSE source so large chunks still type. */
export function useRevealedText(source: string, live: boolean): string {
  const [shown, setShown] = useState(live ? "" : source);

  useEffect(() => {
    if (!live) {
      setShown(source);
      return;
    }
    const reduced = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduced) {
      setShown(source);
      return;
    }
    const id = window.setInterval(() => {
      setShown((current) => {
        if (!source.startsWith(current) && !current.startsWith(source)) return source;
        if (current.length >= source.length) return source;
        const step = source.length - current.length > 80 ? 12 : 3;
        return source.slice(0, Math.min(source.length, current.length + step));
      });
    }, 16);
    return () => window.clearInterval(id);
  }, [source, live]);

  return live ? shown : source;
}
