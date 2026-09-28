// apps/desktop/src/renderer/fileVisuals.ts
//
// PURE artifact-visual logic (no JSX, no React) so tests run under
// --experimental-strip-types. FileTypeIcon.tsx renders it; ArtifactVisual.tsx
// composes it. One mapping — Chat cards, Files → Generated, and previews all
// ask these functions instead of re-implementing extension logic.

import { extensionOf } from "./fileTypeRegistry.ts";

export const IMAGE_EXTENSIONS = /^(png|jpe?g|webp|gif|svg|avif|bmp|ico)$/i;

export type FileIconKey =
  | "ts" | "tsx" | "react" | "js" | "jsx" | "json" | "node" | "python" | "html" | "css" | "sass"
  | "markdown" | "go" | "rust" | "java" | "cs" | "cpp" | "c" | "php" | "vue" | "svelte"
  | "yaml" | "xml" | "sql" | "shell" | "powershell" | "env" | "toml" | "ini" | "docker"
  | "git" | "pdf" | "archive" | "text" | "generic";

/** Filename-level mappings win over extensions (package.json is Node, not JSON). */
export const SPECIAL_FILE_KEYS: Record<string, FileIconKey> = {
  "package.json": "node",
  "package-lock.json": "node",
  "npm-shrinkwrap.json": "node",
  "yarn.lock": "node",
  "pnpm-lock.yaml": "node",
  "tsconfig.json": "ts",
  "jsconfig.json": "js",
  ".gitignore": "git",
  ".gitattributes": "git",
  ".dockerignore": "docker",
  "docker-compose.yml": "docker",
  "docker-compose.yaml": "docker",
  "dockerfile": "docker",
  "compose.yml": "docker",
  "compose.yaml": "docker",
  "license": "text",
  "makefile": "shell",
};

export function fileIconKeyFor(pathOrName: string): FileIconKey {
  const base = (pathOrName.replace(/\\/g, "/").split("/").pop() ?? "").toLowerCase();
  const special = SPECIAL_FILE_KEYS[base];
  if (special) return special;
  switch (extensionOf(pathOrName)) {
    case "ts": return "ts";
    case "tsx": case "jsx": return "react";
    case "js": case "mjs": case "cjs": return "js";
    case "json": return "json";
    case "py": return "python";
    case "html": case "htm": return "html";
    case "css": return "css";
    case "scss": case "sass": case "less": return "sass";
    case "md": case "markdown": case "mdx": return "markdown";
    case "go": return "go";
    case "rs": return "rust";
    case "java": return "java";
    case "cs": return "cs";
    case "cpp": case "cc": case "hpp": return "cpp";
    case "c": case "h": return "c";
    case "php": return "php";
    case "vue": return "vue";
    case "svelte": return "svelte";
    case "yml": case "yaml": return "yaml";
    case "xml": return "xml";
    case "sql": return "sql";
    case "sh": case "bash": case "zsh": case "bat": case "cmd": return "shell";
    case "ps1": return "powershell";
    case "env": return "env";
    case "toml": return "toml";
    case "ini": return "ini";
    case "dockerfile": return "docker";
    case "pdf": return "pdf";
    case "zip": case "tar": case "gz": case "tgz": case "rar": case "7z": return "archive";
    case "txt": return "text";
    default: return "generic";
  }
}

const VISUAL_LABELS: Record<FileIconKey, string> = {
  html: "HTML file", css: "CSS stylesheet", sass: "Sass stylesheet", js: "JavaScript file", jsx: "JavaScript file",
  ts: "TypeScript file", tsx: "TypeScript JSX file", react: "React file", json: "JSON file", node: "Node package file",
  python: "Python file", go: "Go file", rust: "Rust file", java: "Java file", cs: "C# file", cpp: "C++ file", c: "C file",
  php: "PHP file", vue: "Vue file", svelte: "Svelte file", yaml: "YAML file", xml: "XML file", sql: "SQL file",
  shell: "Shell script", powershell: "PowerShell script", env: "Environment file", toml: "TOML file", ini: "INI file",
  docker: "Docker file", git: "Git file", pdf: "PDF document", archive: "Archive", markdown: "Markdown file", text: "Text file",
  generic: "File",
};

/** Accessible tooltip label: "HTML file", "CSS stylesheet", … */
export function visualLabelFor(name: string): string {
  return VISUAL_LABELS[fileIconKeyFor(name)] ?? "File";
}

export type ArtifactVisual =
  | { kind: "thumbnail"; reason: "image" }
  | { kind: "icon"; iconKey: FileIconKey; label: string }
  | { kind: "empty" };

/**
 * THE decision: image assets show their real content; 0-byte files get the
 * muted empty treatment; everything else gets the colorful file-type icon.
 */
export function artifactVisualFor(name: string, opts: { mimeType?: string; size?: number } = {}): ArtifactVisual {
  const ext = name.split(/[\\/]/).pop()?.split(".").pop()?.toLowerCase() ?? "";
  const image = IMAGE_EXTENSIONS.test(ext) || (opts.mimeType ?? "").startsWith("image/");
  if (opts.size === 0) return { kind: "empty" };
  if (image) return { kind: "thumbnail", reason: "image" };
  return { kind: "icon", iconKey: fileIconKeyFor(name), label: visualLabelFor(name) };
}
