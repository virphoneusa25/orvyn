// apps/backend/src/context/ContextEngine.ts
//
// v1 targeted context: never dump the repo into a prompt. Per task, assemble a
// bounded block from (a) code hits for keywords in the task description via
// search_code, (b) the current git diff, (c) the prior task result. Reads go
// through the Tool Gateway with the orchestrator's read-only capabilities.
//
// Tree-sitter AST context and LSP find_references are PENDING interfaces —
// they throw typed errors rather than pretending.

import { ToolGateway } from "../gateway/ToolGateway";

const MAX_CONTEXT_CHARS = 3500;
const STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "into", "then", "when", "where", "which",
  "should", "would", "could", "make", "create", "update", "change", "file", "files", "code",
  "task", "using", "use", "add", "fix", "all", "any", "new", "old", "your", "its", "their",
]);

function keywordsOf(text: string): string[] {
  const words = text.match(/[A-Za-z_][A-Za-z0-9_.-]{3,}/g) ?? [];
  const scored = new Map<string, number>();
  for (const w of words) {
    const key = w.replace(/[.,]+$/, "");
    if (STOPWORDS.has(key.toLowerCase())) continue;
    // camelCase / snake_case / dotted identifiers are the strongest signals.
    const weight = /[A-Z_.]/.test(key.slice(1)) ? 3 : 1;
    scored.set(key, (scored.get(key) ?? 0) + weight);
  }
  return Array.from(scored.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([w]) => w);
}

export class ContextEngine {
  constructor(private tools: ToolGateway) {}

  /** Bounded, targeted context block for a worker prompt. Best-effort: never throws. */
  async buildTaskContext(taskDescription: string, priorResult?: string): Promise<string> {
    const parts: string[] = [];

    try {
      for (const kw of keywordsOf(taskDescription)) {
        const hits = await this.tools.execute("search_code", { pattern: kw, max_results: 8 }, "orchestrator");
        if (hits.ok && hits.output && !/no matches/i.test(hits.output)) {
          parts.push(`Code hits for "${kw}":\n${hits.output.split("\n").slice(0, 8).join("\n")}`);
        }
        if (parts.join("\n").length > MAX_CONTEXT_CHARS) break;
      }
    } catch {
      // search unavailable — proceed with what we have
    }

    try {
      const diff = await this.tools.execute("git_diff", {}, "orchestrator");
      if (diff.ok && diff.output && diff.output !== "(no output)") {
        parts.push(`Current uncommitted diff (truncated):\n${diff.output.slice(0, 1200)}`);
      }
    } catch {
      // not a git repo
    }

    if (priorResult) {
      parts.push(`Previous task result:\n${priorResult.slice(0, 800)}`);
    }

    const block = parts.join("\n\n").slice(0, MAX_CONTEXT_CHARS);
    return block ? `RELEVANT CONTEXT (assembled automatically — verify before relying on it):\n${block}` : "";
  }

  /** Pending: requires LSP. Typed error so callers/UI can surface the real state. */
  findReferences(_symbol: string): never {
    throw new Error("find_references is pending — it requires an LSP integration that is not implemented yet.");
  }

  /** Pending: requires tree-sitter parsers. */
  astOutline(_path: string): never {
    throw new Error("AST outline is pending — tree-sitter integration is not implemented yet.");
  }
}
