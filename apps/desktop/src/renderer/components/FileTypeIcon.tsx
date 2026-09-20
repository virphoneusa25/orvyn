// Local SVG file-type glyphs — presentation half of the registry.
import React from "react";
import { extensionOf, fileTypeOf, TYPES } from "../fileTypeRegistry";

/**
 * Local SVG file-type glyph: a small file sheet with the extension label.
 * Same geometry for every type; color and label carry the identity, so
 * nothing can ever render as a broken image or missing asset.
 */
export function FileTypeIcon({ path: p, size = 16 }: { path: string; size?: number }): React.ReactElement {
  const ext = extensionOf(p);
  const known = Boolean(TYPES[ext]);
  const color = fileTypeOf(p).color;
  const label = known && ext.length <= 4 ? ext.toUpperCase() : "";
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-label={label || "file"} style={{ flexShrink: 0, display: "block" }}>
      <path
        d="M3 1.5h6.2L13 5.3V14a.5.5 0 0 1-.5.5h-9A.5.5 0 0 1 3 14V1.5Z"
        fill={`${color}22`}
        stroke={color}
        strokeWidth="1"
        strokeLinejoin="round"
      />
      <path d="M9 1.7V5h3.4" fill="none" stroke={color} strokeWidth="1" strokeLinejoin="round" opacity="0.7" />
      {label ? (
        <text x="8" y="12" textAnchor="middle" fontSize="5" fontFamily="var(--font-mono, monospace)" fontWeight="700" fill={color}>
          {label}
        </text>
      ) : (
        <circle cx="8" cy="9.5" r="1.4" fill={color} opacity="0.8" />
      )}
    </svg>
  );
}
