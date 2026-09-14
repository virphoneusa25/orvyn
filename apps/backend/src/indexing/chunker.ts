// apps/backend/src/indexing/chunker.ts

export interface Chunk {
  content: string;
  startLine: number;
  endLine: number;
}

export function chunkContent(content: string, chunkLines = 60, overlapLines = 10): Chunk[] {
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
    start = end - overlapLines; // overlap so a match near a boundary isn't lost
  }
  return chunks;
}
