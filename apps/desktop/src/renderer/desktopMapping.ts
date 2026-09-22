// Letterbox-aware coordinate mapping for the Desktop framebuffer.
//
// The remote desktop (e.g. 1280×720) is drawn inside a container that
// preserves aspect ratio — empty bands appear on two sides. Input must map
// through the DISPLAYED IMAGE rect, never the container rect, or clicks
// drift when letterboxed (and at 125%/150% Windows display scaling, where
// CSS px ≠ device px, both sides of the mapping stay in CSS px so DPI cancels).

export interface Rect { x: number; y: number; w: number; h: number }

/** The centered, aspect-preserved image rect inside a container. */
export function letterboxRect(containerW: number, containerH: number, remoteW: number, remoteH: number): Rect {
  if (containerW <= 0 || containerH <= 0 || remoteW <= 0 || remoteH <= 0) {
    return { x: 0, y: 0, w: 0, h: 0 };
  }
  const scale = Math.min(containerW / remoteW, containerH / remoteH);
  const w = remoteW * scale;
  const h = remoteH * scale;
  return { x: (containerW - w) / 2, y: (containerH - h) / 2, w, h };
}

/** CSS-pixel point inside the displayed image → remote desktop pixel.
 *  Returns null when the point falls in the letterbox band. */
export function clientToRemote(
  px: number,
  py: number,
  image: Rect,
  remoteW: number,
  remoteH: number,
): { x: number; y: number } | null {
  if (image.w <= 0 || image.h <= 0) return null;
  const rx = (px - image.x) / image.w;
  const ry = (py - image.y) / image.h;
  if (rx < 0 || ry < 0 || rx > 1 || ry > 1) return null;
  return {
    x: Math.max(0, Math.min(remoteW - 1, Math.round(rx * remoteW))),
    y: Math.max(0, Math.min(remoteH - 1, Math.round(ry * remoteH))),
  };
}

/** Remote desktop pixel → CSS-pixel point inside the displayed image
 *  (used to position the ORION cursor overlay). */
export function remoteToClient(
  rx: number,
  ry: number,
  image: Rect,
  remoteW: number,
  remoteH: number,
): { x: number; y: number } {
  const sx = remoteW > 0 ? image.w / remoteW : 1;
  const sy = remoteH > 0 ? image.h / remoteH : 1;
  return { x: image.x + rx * sx, y: image.y + ry * sy };
}
