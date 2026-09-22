// apps/backend/src/indexing/HybridSearch.ts
//
// One ranked project-search layer combining semantic similarity, keyword/
// path relevance, symbol matches, and recently-edited weighting. This is
// what backs searchCodebase / findSymbol / findFile / relatedFiles without
// dumping the whole repo into model context.

import { promises as fs } from "fs";
import * as path from "path";
import type { CodeSymbol } from "./symbols";
import { extractSymbols, findSymbols, languageOf } from "./symbols";

export interface HybridHit {
  path: string;
  startLine: number;
  endLine: number;
  snippet: string;
  score: number;
  /** Which signals contributed to the score. */
  matchedBy: string[];
  symbol?: string;
}

export interface HybridSearchDeps {
  projectRoot: string;
  /** Semantic search from the vector store (already project-scoped). */
  semanticSearch(query: string, topK: number): Promise<{ path: string; startLine: number; endLine: number; snippet: string; score: number }[]>;
  /** File list for keyword/path fallback. */
  listFiles(): Promise<string[]>;
  /** Read a file's content for symbol extraction. */
  readFile(relPath: string): Promise<string>;
}

const RECENT_WEIGHT = 0.15;
const SYMBOL_WEIGHT = 2.0;
const KEYWORD_WEIGHT = 1.0;
const SEMANTIC_WEIGHT = 1.5;
const PATH_WEIGHT = 0.8;

export class HybridSearch {
  private symbolCache = new Map<string, CodeSymbol[]>();
  private recentEdits = new Map<string, number>(); // path → timestamp

  constructor(private deps: HybridSearchDeps) {}

  /** Called when a file changes — boosts it in ranking and clears cache. */
  noteFileChanged(relPath: string): void {
    this.recentEdits.set(relPath, Date.now());
    this.symbolCache.delete(relPath);
  }

  /** Full hybrid search: semantic + keyword + symbol + recency. */
  async searchCodebase(query: string, topK = 10): Promise<HybridHit[]> {
    const scores = new Map<string, HybridHit>();
    const add = (key: string, hit: HybridHit) => {
      const existing = scores.get(key);
      if (existing) {
        existing.score += hit.score;
        existing.matchedBy = [...new Set([...existing.matchedBy, ...hit.matchedBy])];
      } else {
        scores.set(key, hit);
      }
    };

    // 1) Semantic retrieval (vector similarity, already project-scoped)
    try {
      const semantic = await this.deps.semanticSearch(query, topK * 2);
      for (const hit of semantic) {
        add(`${hit.path}:${hit.startLine}`, {
          path: hit.path, startLine: hit.startLine, endLine: hit.endLine,
          snippet: hit.snippet.slice(0, 200), score: hit.score * SEMANTIC_WEIGHT,
          matchedBy: ["semantic"],
        });
      }
    } catch { /* semantic unavailable — keyword/symbol still work */ }

    // 2) Keyword search across file contents
    const files = await this.deps.listFiles().catch(() => [] as string[]);
    const qLower = query.toLowerCase();
    const words = qLower.split(/\s+/).filter((w) => w.length > 2);
    for (const rel of files.slice(0, 300)) {
      // Path relevance
      const base = path.basename(rel).toLowerCase();
      if (base === qLower || base.replace(/\.[^.]+$/, "") === qLower) {
        add(rel, { path: rel, startLine: 1, endLine: 1, snippet: rel, score: PATH_WEIGHT * 6, matchedBy: ["filename"] });
      } else if (base.includes(qLower) || qLower.includes(base.replace(/\.[^.]+$/, ""))) {
        add(rel, { path: rel, startLine: 1, endLine: 1, snippet: rel, score: PATH_WEIGHT, matchedBy: ["path"] });
      }
      // Content keywords (bounded read)
      try {
        const content = await this.deps.readFile(rel);
        const lines = content.split("\n");
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i].toLowerCase();
          const matches = words.filter((w) => line.includes(w));
          if (matches.length >= Math.ceil(words.length * 0.6)) {
            add(`${rel}:${i + 1}`, {
              path: rel, startLine: i + 1, endLine: i + 1,
              snippet: lines[i].slice(0, 200), score: KEYWORD_WEIGHT * matches.length / Math.max(words.length, 1),
              matchedBy: ["keyword"],
            });
            break; // one hit per file is enough for keyword
          }
        }
      } catch { /* unreadable file — skip */ }
    }

    // 3) Symbol search
    const symbolHits = await this.findSymbol(query);
    for (const hit of symbolHits) {
      add(`${hit.path}:${hit.startLine}`, hit);
    }

    // 4) Recently-edited boost
    const now = Date.now();
    for (const [key, hit] of scores) {
      const editedAt = this.recentEdits.get(hit.path);
      if (editedAt && now - editedAt < 10 * 60_000) {
        hit.score += RECENT_WEIGHT;
        hit.matchedBy.push("recent");
      }
    }

    const ranked = [...scores.values()].sort((a, b) => b.score - a.score);
    return diversify(boostExact(ranked, query), topK);
  }

  /** Symbol-level search across the project. */
  async findSymbol(name: string): Promise<HybridHit[]> {
    const files = await this.deps.listFiles().catch(() => [] as string[]);
    const hits: HybridHit[] = [];
    const codeFiles = files.filter((f) => ["ts", "tsx", "js", "jsx", "py", "go", "rs"].includes((f.split(".").pop() ?? "").toLowerCase()));
    for (const rel of codeFiles.slice(0, 200)) {
      const symbols = await this.getSymbols(rel);
      const matched = findSymbols(symbols, name);
      for (const sym of matched.slice(0, 3)) {
        hits.push({
          path: rel, startLine: sym.startLine, endLine: sym.endLine,
          snippet: sym.signature, score: SYMBOL_WEIGHT * (sym.name.toLowerCase() === name.toLowerCase() ? 2 : 1),
          matchedBy: ["symbol"], symbol: `${sym.kind} ${sym.name}`,
        });
      }
    }
    return hits.sort((a, b) => b.score - a.score).slice(0, 10);
  }

  /** Find files by name or partial path. */
  async findFile(query: string): Promise<string[]> {
    const files = await this.deps.listFiles().catch(() => [] as string[]);
    const q = query.toLowerCase().replace(/\\/g, "/");
    return files
      .filter((f) => f.toLowerCase().includes(q))
      .sort((a, b) => a.length - b.length) // shorter = more likely exact
      .slice(0, 15);
  }

  /** Files related to a given file: shared imports, same directory. */
  async relatedFiles(targetPath: string): Promise<string[]> {
    const files = await this.deps.listFiles().catch(() => [] as string[]);
    const dir = path.dirname(targetPath);
    const targetSymbols = await this.getSymbols(targetPath);
    const targetNames = new Set(targetSymbols.filter((s) => s.kind !== "import").map((s) => s.name));

    const related: { path: string; score: number }[] = [];
    for (const rel of files) {
      if (rel === targetPath) continue;
      let score = 0;
      if (path.dirname(rel) === dir) score += 2;
      const syms = await this.getSymbols(rel).catch(() => [] as CodeSymbol[]);
      for (const s of syms) {
        if (s.kind === "import" && targetSymbols.some((t) => t.kind !== "import" && t.name === s.name)) score += 1;
        if (s.kind !== "import" && targetNames.has(s.name)) score += 3;
      }
      if (score > 0) related.push({ path: rel, score });
    }
    return related.sort((a, b) => b.score - a.score).slice(0, 8).map((r) => r.path);
  }

  async searchTests(targetPath: string): Promise<string[]> {
    const files = await this.deps.listFiles().catch(() => [] as string[]);
    const base = path.basename(targetPath).replace(/\.[^.]+$/, "");
    const dir = path.dirname(targetPath);
    return files
      .filter((f) => {
        const n = f.toLowerCase();
        return (
          n.includes(".test.") ||
          n.includes(".spec.") ||
          n.includes("/tests/") ||
          n.includes("/__tests__/") ||
          (path.dirname(f) === dir && n.includes(base.toLowerCase()) && n !== targetPath.toLowerCase())
        );
      })
      .slice(0, 12);
  }

  async outline(): Promise<{ directories: string[]; entryPoints: string[]; configs: string[] }> {
    const files = await this.deps.listFiles().catch(() => [] as string[]);
    const directories = [...new Set(files.map((f) => f.split("/")[0]).filter(Boolean))].slice(0, 16);
    const configs = files.filter((f) => /^(package\.json|tsconfig|pyproject|go\.mod|Cargo\.toml|Dockerfile|README)/i.test(path.basename(f))).slice(0, 12);
    const entryPoints = files.filter((f) => /(^|\/)(index|main|app|server)\.[a-z]+$/i.test(f)).slice(0, 12);
    return { directories, entryPoints, configs };
  }

  private async getSymbols(relPath: string): Promise<CodeSymbol[]> {
    const cached = this.symbolCache.get(relPath);
    if (cached) return cached;
    try {
      const content = await this.deps.readFile(relPath);
      const symbols = extractSymbols(content, relPath);
      this.symbolCache.set(relPath, symbols);
      return symbols;
    } catch {
      return [];
    }
  }
}

function boostExact(hits: HybridHit[], query: string): HybridHit[] {
  const q = query.trim().toLowerCase();
  if (!q) return hits;
  return hits.map((h) => {
    const base = path.basename(h.path).toLowerCase();
    const exactSymbol = h.symbol?.toLowerCase().endsWith(q);
    if (exactSymbol) return { ...h, score: h.score + SYMBOL_WEIGHT, matchedBy: [...new Set([...h.matchedBy, "exact-symbol"])] };
    if (base === q) return { ...h, score: h.score + PATH_WEIGHT * 4, matchedBy: [...new Set([...h.matchedBy, "exact-file"])] };
    return h;
  }).sort((a, b) => b.score - a.score);
}

/** Prefer evidence from several files over many chunks of one file. */
function diversify(hits: HybridHit[], topK: number, maxPerFile = 3): HybridHit[] {
  const counts = new Map<string, number>();
  const out: HybridHit[] = [];
  for (const hit of hits) {
    const n = counts.get(hit.path) ?? 0;
    if (n >= maxPerFile) continue;
    counts.set(hit.path, n + 1);
    out.push(hit);
    if (out.length >= topK) break;
  }
  return out;
}
