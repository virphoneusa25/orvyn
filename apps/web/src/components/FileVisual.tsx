import { useEffect, useRef, useState } from "react";
import { blobUrl, imageLink } from "../lib/api";
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

/**
 * An image's real thumbnail, loaded when it scrolls into view: first as a
 * short-lived direct link (the browser loads it itself), then — if that fails —
 * fetched with the session. Never stuck on "loading": it ends as the picture
 * or as the file's icon.
 */
export function Thumb({ artifactId, name, className, fallbackSize = 40 }: { artifactId: string; name: string; className?: string; fallbackSize?: number }) {
  const [src, setSrc] = useState<string | null>(cache.get(artifactId) ?? null);
  const [failed, setFailed] = useState(false);
  const [triedBlob, setTriedBlob] = useState(false);
  const ref = useRef<HTMLSpanElement | null>(null);
  const viaBlob = () => {
    setTriedBlob(true);
    blobUrl(`/artifacts/${encodeURIComponent(artifactId)}/preview`)
      .then(({ url }) => { cache.set(artifactId, url); setSrc(url); })
      .catch(() => setFailed(true));
  };
  useEffect(() => {
    if (src || failed) return;
    const el = ref.current;
    if (!el) return;
    const start = () => { imageLink(artifactId).then(setSrc).catch(viaBlob); };
    if (typeof IntersectionObserver === "undefined") { start(); return; }
    const io = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      io.disconnect();
      start();
    }, { rootMargin: "200px" });
    io.observe(el);
    return () => io.disconnect();
  }, [artifactId, src, failed]); // eslint-disable-line react-hooks/exhaustive-deps
  if (src) return <img className={className} src={src} alt={name} data-testid="thumb" loading="lazy" onError={() => { cache.delete(artifactId); setSrc(null); if (triedBlob) setFailed(true); else viaBlob(); }} />;
  return <span ref={ref} style={{ display: "inline-grid" }}>{failed ? <FileIcon name={name} mimeType="image/png" size={fallbackSize} /> : <span className="thumb-loading" style={{ width: fallbackSize, height: fallbackSize }} aria-label="Loading image" />}</span>;
}

/** Thumbnail for images, typed icon for everything else. */
export function FileVisual({ artifactId, name, mimeType, size = 34, thumbClass = "thumb-sm" }: { artifactId?: string; name: string; mimeType?: string; size?: number; thumbClass?: string }) {
  if (artifactId && fileKind(name, mimeType) === "image") return <Thumb artifactId={artifactId} name={name} className={thumbClass} fallbackSize={size} />;
  return <FileIcon name={name} mimeType={mimeType} size={size} />;
}
