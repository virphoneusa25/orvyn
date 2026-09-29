import { useEffect, useRef, useState } from "react";
import { blobUrl } from "../lib/api";
import { fileKind, KIND_STYLE } from "../lib/fileKinds";

/** The typed icon for a file (HTML, CSS, JS, TS, JSON, PDF…). */
export function FileIcon({ name, mimeType = "", size = 34 }: { name: string; mimeType?: string; size?: number }) {
  const k = fileKind(name, mimeType);
  const s = KIND_STYLE[k];
  return (
    <span className="fileicon" data-kind={k} style={{ width: size, height: size * 1.18, background: s.bg, fontSize: Math.max(9, size * (s.label.length > 3 ? 0.27 : 0.34)) }} aria-label={`${s.label} file`}>
      {s.label}
    </span>
  );
}

const cache = new Map<string, string>();

/** An image's real thumbnail (loaded with the session when it scrolls into view). */
export function Thumb({ artifactId, name, className, fallbackSize = 40 }: { artifactId: string; name: string; className?: string; fallbackSize?: number }) {
  const [src, setSrc] = useState<string | null>(cache.get(artifactId) ?? null);
  const [failed, setFailed] = useState(false);
  const ref = useRef<HTMLSpanElement | null>(null);
  useEffect(() => {
    if (src || failed) return;
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      io.disconnect();
      blobUrl(`/artifacts/${encodeURIComponent(artifactId)}/preview`)
        .then(({ url }) => { cache.set(artifactId, url); setSrc(url); })
        .catch(() => setFailed(true));
    }, { rootMargin: "200px" });
    io.observe(el);
    return () => io.disconnect();
  }, [artifactId, src, failed]);
  if (src) return <img className={className} src={src} alt={name} data-testid="thumb" />;
  return <span ref={ref} style={{ display: "inline-grid" }}>{failed ? <FileIcon name={name} mimeType="image/png" size={fallbackSize} /> : <span className="faint" style={{ fontSize: 12 }}>…</span>}</span>;
}

/** Thumbnail for images, typed icon for everything else. */
export function FileVisual({ artifactId, name, mimeType, size = 34, thumbClass = "thumb-sm" }: { artifactId?: string; name: string; mimeType?: string; size?: number; thumbClass?: string }) {
  if (artifactId && fileKind(name, mimeType) === "image") return <Thumb artifactId={artifactId} name={name} className={thumbClass} fallbackSize={size} />;
  return <FileIcon name={name} mimeType={mimeType} size={size} />;
}
