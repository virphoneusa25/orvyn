// Structural chunking: prefer AST/symbol ranges, fall back to intelligent
// text windows for unsupported languages. Never drop line metadata.

import { extractSymbols, languageOf, type CodeSymbol } from "./symbols";

export interface Chunk {
  content: string;
  startLine: number;
  endLine: number;
  symbol?: string;
  symbolKind?: string;
  language?: string;
}

const STRUCTURAL_LANGS = new Set(["typescript", "javascript", "python", "go", "rust"]);
const FALLBACK_LINES = 80;
const FALLBACK_OVERLAP = 12;

/** Legacy windowed splitter — used when no structural symbols exist. */
export function chunkContent(content: string, chunkLines = 60, overlapLines = 10): Chunk[] {
  return windowChunks(content, chunkLines, overlapLines);
}

export function chunkFile(filePath: string, content: string): Chunk[] {
  const language = languageOf(filePath);
  if (STRUCTURAL_LANGS.has(language)) {
    const symbols = extractSymbols(content, filePath).filter((s) => s.kind !== "import");
    const structural = structuralChunks(content, symbols, language);
    if (structural.length > 0) return structural;
  }
  return windowChunks(content, FALLBACK_LINES, FALLBACK_OVERLAP).map((c) => ({ ...c, language }));
}

function structuralChunks(content: string, symbols: CodeSymbol[], language: string): Chunk[] {
  const lines = content.split("\n");
  if (symbols.length === 0) return [];
  const ranked = [...symbols].sort((a, b) => a.startLine - b.startLine || kindRank(a.kind) - kindRank(b.kind));
  const chunks: Chunk[] = [];
  for (let i = 0; i < ranked.length; i++) {
    const sym = ranked[i];
    const start = Math.max(1, sym.startLine);
    const next = ranked[i + 1]?.startLine ?? lines.length + 1;
    const end = Math.min(lines.length, Math.max(start, next - 1));
    if (end < start) continue;
    const slice = lines.slice(start - 1, end).join("\n");
    if (!slice.trim()) continue;
    chunks.push({
      content: slice,
      startLine: start,
      endLine: end,
      symbol: sym.name,
      symbolKind: sym.kind,
      language,
    });
  }
  return mergeTiny(chunks, lines, language);
}

function mergeTiny(chunks: Chunk[], lines: string[], language: string): Chunk[] {
  if (chunks.length === 0) return [];
  const out: Chunk[] = [];
  for (const c of chunks) {
    const last = out[out.length - 1];
    if (last && c.endLine - c.startLine < 3 && last.endLine - last.startLine < 40) {
      last.endLine = c.endLine;
      last.content = lines.slice(last.startLine - 1, last.endLine).join("\n");
      continue;
    }
    out.push({ ...c, language: c.language ?? language });
  }
  return out;
}

function kindRank(kind: CodeSymbol["kind"]): number {
  switch (kind) {
    case "class":
    case "interface":
      return 0;
    case "function":
    case "method":
      return 1;
    default:
      return 2;
  }
}

function windowChunks(content: string, chunkLines: number, overlapLines: number): Chunk[] {
  const lines = content.split("\n");
  if (lines.length <= chunkLines) {
    return [{ content, startLine: 1, endLine: lines.length }];
  }
  const chunks: Chunk[] = [];
  let start = 0;
  while (start < lines.length) {
    const end = Math.min(start + chunkLines, lines.length);
    chunks.push({
      content: lines.slice(start, end).join("\n"),
      startLine: start + 1,
      endLine: end,
    });
    if (end === lines.length) break;
    start = end - overlapLines;
  }
  return chunks;
}
