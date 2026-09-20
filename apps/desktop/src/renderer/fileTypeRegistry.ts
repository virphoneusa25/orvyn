// apps/desktop/src/renderer/fileTypeRegistry.ts
//
// ONE authoritative extension → language → icon mapping. Local SVG glyph
// components only — no remote URLs, no emoji, no broken images: unknown
// extensions render the generic file glyph (contract pinned by unit test).

export interface FileTypeEntry {
  /** Monaco language id for syntax highlighting. */
  languageId: string;
  /** Accent color for the glyph. */
  color: string;
}

export const TYPES: Record<string, FileTypeEntry> = {
  ts: { languageId: "typescript", color: "#6C5CFF" },
  tsx: { languageId: "typescript", color: "#6C5CFF" },
  js: { languageId: "javascript", color: "#F5B942" },
  jsx: { languageId: "javascript", color: "#F5B942" },
  mjs: { languageId: "javascript", color: "#F5B942" },
  cjs: { languageId: "javascript", color: "#F5B942" },
  json: { languageId: "json", color: "#F5B942" },
  html: { languageId: "html", color: "#F25F75" },
  htm: { languageId: "html", color: "#F25F75" },
  css: { languageId: "css", color: "#22D3EE" },
  scss: { languageId: "scss", color: "#22D3EE" },
  less: { languageId: "less", color: "#22D3EE" },
  md: { languageId: "markdown", color: "#8fa3b8" },
  markdown: { languageId: "markdown", color: "#8fa3b8" },
  py: { languageId: "python", color: "#20D89B" },
  go: { languageId: "go", color: "#22D3EE" },
  rs: { languageId: "rust", color: "#F25F75" },
  java: { languageId: "java", color: "#F25F75" },
  cs: { languageId: "csharp", color: "#4DA3FF" },
  cpp: { languageId: "cpp", color: "#4DA3FF" },
  cc: { languageId: "cpp", color: "#4DA3FF" },
  c: { languageId: "cpp", color: "#4DA3FF" },
  h: { languageId: "cpp", color: "#4DA3FF" },
  hpp: { languageId: "cpp", color: "#4DA3FF" },
  yml: { languageId: "yaml", color: "#8fa3b8" },
  yaml: { languageId: "yaml", color: "#8fa3b8" },
  xml: { languageId: "xml", color: "#8fa3b8" },
  sql: { languageId: "sql", color: "#F5B942" },
  sh: { languageId: "shell", color: "#8fa3b8" },
  bash: { languageId: "shell", color: "#8fa3b8" },
  ps1: { languageId: "powershell", color: "#4DA3FF" },
  bat: { languageId: "bat", color: "#8fa3b8" },
  cmd: { languageId: "bat", color: "#8fa3b8" },
  env: { languageId: "ini", color: "#F5B942" },
  toml: { languageId: "ini", color: "#8fa3b8" },
  ini: { languageId: "ini", color: "#8fa3b8" },
  vue: { languageId: "html", color: "#20D89B" },
  svelte: { languageId: "html", color: "#F25F75" },
  php: { languageId: "php", color: "#8b9cd4" },
  txt: { languageId: "plaintext", color: "#8fa3b8" },
  dockerfile: { languageId: "dockerfile", color: "#4DA3FF" },
};

const GENERIC: FileTypeEntry = { languageId: "plaintext", color: "#8fa3b8" };

export function extensionOf(pathOrName: string): string {
  const base = (pathOrName.replace(/\\/g, "/").split("/").pop() ?? "").toLowerCase();
  if (base === "dockerfile") return "dockerfile";
  if (base.startsWith(".env")) return "env";
  if (base.startsWith("makefile")) return "sh";
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1) : "";
}

export function fileTypeOf(pathOrName: string): FileTypeEntry {
  return TYPES[extensionOf(pathOrName)] ?? GENERIC;
}

/** The extensions the spec requires — the coverage test iterates this. */
export const SUPPORTED_EXTENSIONS = Object.keys(TYPES);
