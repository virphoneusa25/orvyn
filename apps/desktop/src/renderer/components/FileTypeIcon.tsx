// apps/desktop/src/renderer/components/FileTypeIcon.tsx
//
// Real, recognizable per-language file icons — the familiar brand marks
// (TypeScript blue square, JavaScript yellow square, the Python two-snake,
// Vue chevrons, SQL cylinder, HTML/CSS shields…) drawn as LOCAL SVGs.
// No remote URLs, no emoji, no bitmap assets: nothing can fail to load.
// The registry stays the authority for language ids; this file owns glyphs.

import React from "react";
import { extensionOf } from "../fileTypeRegistry";

const S = 16; // canvas; glyphs drawn in a 16×16 viewBox

function Square({ color, label, textColor = "#fff", fontSize = 8 }: { color: string; label: string; textColor?: string; fontSize?: number }) {
  return (
    <svg width={S} height={S} viewBox="0 0 16 16" role="img" aria-label={label} style={{ display: "block", flexShrink: 0 }}>
      <rect x="1" y="1" width="14" height="14" rx="3" fill={color} />
      <text x="8" y="11.4" textAnchor="middle" fontSize={fontSize} fontWeight="700" fontFamily="var(--font-mono, monospace)" fill={textColor}>
        {label}
      </text>
    </svg>
  );
}

/** TypeScript: the official blue square + white TS. */
const TsIcon = ({ label }: { label: string }) => (
  <svg width={S} height={S} viewBox="0 0 16 16" role="img" aria-label={label} style={{ display: "block", flexShrink: 0 }}>
    <rect x="0.5" y="0.5" width="15" height="15" rx="2" fill="#3178C6" />
    <text x="8" y="11.6" textAnchor="middle" fontSize="7.5" fontWeight="700" fontFamily="var(--font-mono, monospace)" fill="#fff">{label}</text>
  </svg>
);

/** JavaScript: official yellow square, dark JS. */
const JsIcon = ({ label }: { label: string }) => (
  <svg width={S} height={S} viewBox="0 0 16 16" role="img" aria-label={label} style={{ display: "block", flexShrink: 0 }}>
    <rect x="0.5" y="0.5" width="15" height="15" rx="2" fill="#F7DF1E" />
    <text x="8" y="11.6" textAnchor="middle" fontSize="7.5" fontWeight="700" fontFamily="var(--font-mono, monospace)" fill="#222">{label}</text>
  </svg>
);

/** Python: the classic two interlocking snakes, simplified but unmistakable. */
const PythonIcon = () => (
  <svg width={S} height={S} viewBox="0 0 16 16" role="img" aria-label="Python" style={{ display: "block", flexShrink: 0 }}>
    <path d="M8 1c-2.2 0-3 .8-3 2.4V5h3.2v.7H3.4C1.9 5.7 1 6.7 1 8.5s.8 2.8 2.4 2.8h1.4v-1.9c0-1.5 1-2.4 2.5-2.4h3c1.3 0 2.2-.9 2.2-2.2V3.4C12.5 1.9 11.4 1 8 1zM6.4 2.5a.7.7 0 1 1 0 1.4.7.7 0 0 1 0-1.4z" fill="#3776AB" />
    <path d="M8 15c2.2 0 3-.8 3-2.4V11H7.8v-.7h4.8c1.5 0 2.4-1 2.4-2.8S14.2 4.7 12.6 4.7h-1.4v1.9c0 1.5-1 2.4-2.5 2.4h-3C4.4 9 3.5 9.9 3.5 11.2v1.4C3.5 14.1 4.6 15 8 15zm1.6-1.5a.7.7 0 1 1 0-1.4.7.7 0 0 1 0 1.4z" fill="#FFD43B" />
  </svg>
);

/** Vue: nested green chevrons. */
const VueIcon = () => (
  <svg width={S} height={S} viewBox="0 0 16 16" role="img" aria-label="Vue" style={{ display: "block", flexShrink: 0 }}>
    <path d="M1 3h2.8L8 9l4.2-6H15L8 15 1 3z" fill="#42B883" />
    <path d="M4.9 3h1.9L8 5.7 9.2 3h1.9L8 8 4.9 3z" fill="#35495E" />
  </svg>
);

/** SQL: a database cylinder. */
const SqlIcon = () => (
  <svg width={S} height={S} viewBox="0 0 16 16" role="img" aria-label="SQL" style={{ display: "block", flexShrink: 0 }}>
    <ellipse cx="8" cy="3.4" rx="5.5" ry="2.1" fill="#F29111" />
    <path d="M2.5 3.4v9.2c0 1.2 2.5 2.1 5.5 2.1s5.5-.9 5.5-2.1V3.4" fill="none" stroke="#F29111" strokeWidth="1.6" />
    <ellipse cx="8" cy="3.4" rx="5.5" ry="2.1" fill="none" stroke="#F29111" strokeWidth="1.6" />
  </svg>
);

/** HTML: the orange shield. */
const HtmlIcon = () => (
  <svg width={S} height={S} viewBox="0 0 16 16" role="img" aria-label="HTML" style={{ display: "block", flexShrink: 0 }}>
    <path d="M2 1h12l-1.1 12.4L8 15l-4.9-1.6L2 1z" fill="#E34F26" />
    <path d="M8 2.7v10.6l3.6-1.2 1-8.2H8z" fill="#F16529" opacity="0.85" />
    <path d="M5.2 4.6H8v1.5H6.8l.1 1.5H8v1.5H5.6l-.4-4.5zM8 10.1l1.6-.6.1-1.2H9.6L8 8.9v1.2z" fill="#fff" />
  </svg>
);

/** CSS: the blue shield. */
const CssIcon = ({ color = "#1572B6", label = "3" }: { color?: string; label?: string }) => (
  <svg width={S} height={S} viewBox="0 0 16 16" role="img" aria-label="CSS" style={{ display: "block", flexShrink: 0 }}>
    <path d="M2 1h12l-1.1 12.4L8 15l-4.9-1.6L2 1z" fill={color} />
    <text x="8" y="10.6" textAnchor="middle" fontSize="7" fontWeight="700" fontFamily="var(--font-mono, monospace)" fill="#fff">{label}</text>
  </svg>
);

/** Markdown: the official outline with M▼. */
const MdIcon = () => (
  <svg width={S} height={S} viewBox="0 0 16 16" role="img" aria-label="Markdown" style={{ display: "block", flexShrink: 0 }}>
    <rect x="0.5" y="3" width="15" height="10" rx="2" fill="none" stroke="#8fa3b8" strokeWidth="1.4" />
    <path d="M3 11V5.5h1.6L6.4 7.6l1.8-2.1H9.8V11H8.2V8L6.4 10.1 4.6 8v3H3z" fill="#8fa3b8" />
    <path d="M10.6 5.5h1.6v3l1.6-1.7v3.4l-1.6-1.7V11h-1.6V5.5z" fill="#8fa3b8" opacity="0" />
    <path d="M11 5.5h1.4l1.2 1.4V5.5h1.2v0H11z" fill="none" />
    <path d="M10.8 8.9V5.6h1.3l1 1.2V5.6h1.3v3.3h-1.3l-1-1.2v1.2h-1.3z" fill="#8fa3b8" />
  </svg>
);

/** Rust: dark gear-square with R. */
const RustIcon = () => <Square color="#8B4513" label="R" />;
/** Go: gopher-blue GO. */
const GoIcon = () => <Square color="#00ADD8" label="GO" fontSize={6.5} />;
/** Java: orange cup-ish J. */
const JavaIcon = () => <Square color="#E76F00" label="J" />;
/** C#: purple square. */
const CsIcon = () => <Square color="#68217A" label="C#" fontSize={7} />;
/** C++: blue square. */
const CppIcon = () => <Square color="#00599C" label="C++" fontSize={6.5} />;
/** C. */
const CIcon = () => <Square color="#5C6BC0" label="C" />;
/** PHP. */
const PhpIcon = () => <Square color="#777BB4" label="php" fontSize={6.5} />;
/** Shell: dark terminal square. */
const ShellIcon = ({ label = "$_" }: { label?: string }) => <Square color="#2B3137" label={label} fontSize={7} />;
/** PowerShell. */
const PsIcon = () => <Square color="#5391FE" label=">_" fontSize={7} />;
/** YAML. */
const YamlIcon = () => <Square color="#CB171E" label="Y" />;
/** XML: angle brackets. */
const XmlIcon = () => <Square color="#F26522" label="</>" fontSize={6} />;
/** Env / toml / ini: gear-tinted. */
const EnvIcon = () => <Square color="#ECD53F" label=".E" textColor="#3a3a00" fontSize={6.5} />;
const TomlIcon = ({ label }: { label: string }) => <Square color="#9C4121" label={label} fontSize={5.5} />;
/** Svelte. */
const SvelteIcon = () => <Square color="#FF3E00" label="S" />;
/** Dockerfile: blue container stack. */
const DockerIcon = () => (
  <svg width={S} height={S} viewBox="0 0 16 16" role="img" aria-label="Docker" style={{ display: "block", flexShrink: 0 }}>
    <path d="M3 7h2v2H3V7zm3 0h2v2H6V7zm3 0h2v2H9V7zm1.5-3h2v2h-2V4zM6 4h2v2H6V4zM3 4h2v2H3V4z" fill="#2496ED" />
    <path d="M1.5 9.8c1.2 2.5 4 3.7 7.3 3.7 3 0 5-1.2 6-3 .4-.8.5-1.7.2-2.3-.4-.7-1.2-1-2.2-1H3.5c-1.4 0-2.4.9-2 2.6z" fill="#2496ED" opacity="0.85" />
  </svg>
);

/** Generic fallback: the muted document sheet — never a broken image. */
const GenericIcon = () => (
  <svg width={S} height={S} viewBox="0 0 16 16" role="img" aria-label="file" style={{ display: "block", flexShrink: 0 }}>
    <path d="M3 1.5h6.2L13 5.3V14a.5.5 0 0 1-.5.5h-9A.5.5 0 0 1 3 14V1.5Z" fill="rgba(143,163,184,0.15)" stroke="#8fa3b8" strokeLinejoin="round" />
    <path d="M9 1.7V5h3.4" fill="none" stroke="#8fa3b8" opacity="0.7" strokeLinejoin="round" />
  </svg>
);

/** The public entry: brand icon per extension, generic fallback otherwise. */
export function FileTypeIcon({ path: p, size = 16 }: { path: string; size?: number }): React.ReactElement {
  const ext = extensionOf(p);
  const glyph = (() => {
    switch (ext) {
      case "ts": return <TsIcon label="TS" />;
      case "tsx": return <TsIcon label="TSX" />;
      case "js": case "mjs": return <JsIcon label="JS" />;
      case "jsx": case "cjs": return <JsIcon label="JSX" />;
      case "json": return <JsIcon label="{ }" />;
      case "py": return <PythonIcon />;
      case "html": case "htm": return <HtmlIcon />;
      case "css": return <CssIcon />;
      case "scss": case "less": return <CssIcon color="#CC6699" label="S" />;
      case "md": case "markdown": return <MdIcon />;
      case "go": return <GoIcon />;
      case "rs": return <RustIcon />;
      case "java": return <JavaIcon />;
      case "cs": return <CsIcon />;
      case "cpp": case "cc": case "c": case "h": case "hpp": return <CppIcon />;
      case "php": return <PhpIcon />;
      case "vue": return <VueIcon />;
      case "svelte": return <SvelteIcon />;
      case "yml": case "yaml": return <YamlIcon />;
      case "xml": return <XmlIcon />;
      case "sql": return <SqlIcon />;
      case "sh": case "bash": return <ShellIcon />;
      case "ps1": return <PsIcon />;
      case "bat": case "cmd": return <ShellIcon label="BAT" />;
      case "env": return <EnvIcon />;
      case "toml": return <TomlIcon label="TOML" />;
      case "ini": return <TomlIcon label="INI" />;
      case "dockerfile": return <DockerIcon />;
      default: return <GenericIcon />;
    }
  })();
  if (size === 16) return glyph;
  return <span style={{ width: size, height: size, display: "inline-flex", transform: `scale(${size / 16})`, transformOrigin: "top left" }}>{glyph}</span>;
}
