// apps/backend/src/composer/diff.ts
// Minimal LCS-based line diff — enough to drive an "additions/deletions"
// summary and a unified-style diff view. Not meant to replace `git diff`
// for huge files; fine for the file sizes an AI edit touches.

export type DiffLineType = "context" | "add" | "remove";

export interface DiffLine {
  type: DiffLineType;
  content: string;
}

export function diffLines(before: string, after: string): DiffLine[] {
  const a = before.split("\n");
  const b = after.split("\n");
  const n = a.length;
  const m = b.length;

  // LCS table
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const result: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      result.push({ type: "context", content: a[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      result.push({ type: "remove", content: a[i] });
      i++;
    } else {
      result.push({ type: "add", content: b[j] });
      j++;
    }
  }
  while (i < n) {
    result.push({ type: "remove", content: a[i] });
    i++;
  }
  while (j < m) {
    result.push({ type: "add", content: b[j] });
    j++;
  }
  return result;
}

export function diffStats(lines: DiffLine[]): { additions: number; deletions: number } {
  return {
    additions: lines.filter((l) => l.type === "add").length,
    deletions: lines.filter((l) => l.type === "remove").length,
  };
}
