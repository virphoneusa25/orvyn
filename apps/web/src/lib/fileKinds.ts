// How a file is shown: images get their real thumbnail; everything else a
// typed icon. Preview is local rendering only — it never calls a model.

export type FileKind = "image" | "html" | "css" | "js" | "ts" | "json" | "pdf" | "md" | "txt" | "csv" | "doc" | "xls" | "ppt" | "code" | "zip" | "audio" | "video" | "file";

const EXT: Record<string, FileKind> = {
  png: "image", jpg: "image", jpeg: "image", gif: "image", webp: "image", svg: "image", bmp: "image", avif: "image",
  html: "html", htm: "html", css: "css", scss: "css", js: "js", mjs: "js", cjs: "js", jsx: "js", ts: "ts", tsx: "ts",
  json: "json", pdf: "pdf", md: "md", markdown: "md", txt: "txt", log: "txt", csv: "csv", tsv: "csv",
  doc: "doc", docx: "doc", xls: "xls", xlsx: "xls", ppt: "ppt", pptx: "ppt",
  py: "code", go: "code", rs: "code", java: "code", c: "code", cpp: "code", cs: "code", rb: "code", php: "code", sh: "code", yml: "code", yaml: "code", sql: "code", xml: "code",
  zip: "zip", gz: "zip", tar: "zip", mp3: "audio", wav: "audio", mp4: "video", webm: "video", mov: "video",
};

export function fileKind(name: string, mimeType = ""): FileKind {
  const ext = (name.split(".").pop() ?? "").toLowerCase();
  if (EXT[ext]) return EXT[ext]!;
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType === "application/pdf") return "pdf";
  if (mimeType.includes("html")) return "html";
  if (mimeType.includes("json")) return "json";
  if (mimeType.startsWith("text/")) return "txt";
  return "file";
}

/** Icon label and colour for a kind (the Files page and chat chips). */
export const KIND_STYLE: Record<FileKind, { label: string; bg: string }> = {
  image: { label: "IMG", bg: "linear-gradient(135deg,#22d3ee,#6366f1)" },
  html: { label: "HTML", bg: "linear-gradient(135deg,#f97316,#ea580c)" },
  css: { label: "CSS", bg: "linear-gradient(135deg,#3b82f6,#1d4ed8)" },
  js: { label: "JS", bg: "linear-gradient(135deg,#facc15,#ca8a04)" },
  ts: { label: "TS", bg: "linear-gradient(135deg,#3b82f6,#2563eb)" },
  json: { label: "{ }", bg: "linear-gradient(135deg,#a3a3a3,#525252)" },
  pdf: { label: "PDF", bg: "linear-gradient(135deg,#ef4444,#b91c1c)" },
  md: { label: "MD", bg: "linear-gradient(135deg,#94a3b8,#475569)" },
  txt: { label: "TXT", bg: "linear-gradient(135deg,#94a3b8,#64748b)" },
  csv: { label: "CSV", bg: "linear-gradient(135deg,#22c55e,#15803d)" },
  doc: { label: "W", bg: "linear-gradient(135deg,#3b82f6,#1e40af)" },
  xls: { label: "X", bg: "linear-gradient(135deg,#22c55e,#166534)" },
  ppt: { label: "P", bg: "linear-gradient(135deg,#f97316,#c2410c)" },
  code: { label: "</>", bg: "linear-gradient(135deg,#8b5cf6,#6d28d9)" },
  zip: { label: "ZIP", bg: "linear-gradient(135deg,#a8a29e,#57534e)" },
  audio: { label: "♪", bg: "linear-gradient(135deg,#ec4899,#be185d)" },
  video: { label: "▶", bg: "linear-gradient(135deg,#ec4899,#7c3aed)" },
  file: { label: "FILE", bg: "linear-gradient(135deg,#64748b,#334155)" },
};

/** How the preview pane renders a kind (null: download only). */
export function previewMode(kind: FileKind): "image" | "html" | "pdf" | "text" | "video" | "audio" | null {
  if (kind === "image") return "image";
  if (kind === "html") return "html";
  if (kind === "pdf") return "pdf";
  if (["css", "js", "ts", "json", "md", "txt", "csv", "code"].includes(kind)) return "text";
  if (kind === "video") return "video";
  if (kind === "audio") return "audio";
  return null;
}

/** What a chat can send to the model for a file: images as pixels, text as text, others by name only. */
export function attachmentRole(name: string, mimeType: string): "image" | "text" | "binary" {
  const k = fileKind(name, mimeType);
  if (k === "image" && !/svg/.test(mimeType) && !name.toLowerCase().endsWith(".svg")) return "image";
  if (["html", "css", "js", "ts", "json", "md", "txt", "csv", "code"].includes(k) || name.toLowerCase().endsWith(".svg")) return "text";
  return "binary";
}
