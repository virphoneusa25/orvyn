// apps/backend/src/indexing/symbols.ts
//
// Structural code parsing: extracts functions, classes, methods, interfaces,
// types, imports, and exports from source files WITHOUT Tree-sitter (which
// needs native bindings per-platform). This regex-based parser covers the
// common TypeScript/JavaScript/Python/Go/Rust/Java/C# shapes that matter for
// symbol-level retrieval; unknown languages get a minimal fallback.
//
// Symbols are indexed alongside text chunks in the namespaced vector store
// so searchCodebase(query) and findSymbol(name) work over real structure.

export interface CodeSymbol {
  name: string;
  kind: "function" | "method" | "class" | "interface" | "type" | "import" | "export" | "variable" | "unknown";
  language: string;
  startLine: number;
  endLine: number;
  signature: string;
}

const LANG_BY_EXT: Record<string, string> = {
  ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript",
  mjs: "javascript", cjs: "javascript", py: "python", go: "go", rs: "rust",
  java: "java", cs: "csharp", rb: "ruby", php: "php", cpp: "cpp", c: "c",
};

export function languageOf(path: string): string {
  const ext = (path.split(".").pop() ?? "").toLowerCase();
  return LANG_BY_EXT[ext] ?? "plaintext";
}

// ── TypeScript/JavaScript ────────────────────────────────────────────────

const TS_PATTERNS: { re: RegExp; kind: CodeSymbol["kind"] }[] = [
  { re: /(?:^|\n)\s*export\s+(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/, kind: "function" },
  { re: /(?:^|\n)\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/, kind: "function" },
  { re: /(?:^|\n)\s*export\s+(?:default\s+)?class\s+([A-Za-z_$][\w$]*)/, kind: "class" },
  { re: /(?:^|\n)\s*(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, kind: "class" },
  { re: /(?:^|\n)\s*export\s+interface\s+([A-Za-z_$][\w$]*)/, kind: "interface" },
  { re: /(?:^|\n)\s*interface\s+([A-Za-z_$][\w$]*)/, kind: "interface" },
  { re: /(?:^|\n)\s*export\s+type\s+([A-Za-z_$][\w$]*)/, kind: "type" },
  { re: /(?:^|\n)\s*type\s+([A-Za-z_$][\w$]*)\s*[=<]/, kind: "type" },
  { re: /(?:^|\n)\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\(|function|[A-Z])/, kind: "variable" },
  { re: /(?:^|\n)\s*(?:export\s+)?enum\s+([A-Za-z_$][\w$]*)/, kind: "type" },
];

// Class methods: `methodName(...) {` inside a class body (indentation heuristic)
const TS_METHOD_RE = /(?:^|\n)(\s+)(?:public\s+|private\s+|protected\s+|static\s+|async\s+|readonly\s+|override\s+|get\s+|set\s+)*([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\([^)]*\)\s*(?::\s*[^{;]+)?\s*\{/g;

const TS_IMPORT_RE = /(?:^|\n)\s*import\s+.*?from\s+['"]([^'"]+)['"]/g;
const TS_EXPORT_RE = /(?:^|\n)\s*export\s+(?:\{[^}]*\}|\*|default)/g;

// ── Python ───────────────────────────────────────────────────────────────

const PY_PATTERNS: { re: RegExp; kind: CodeSymbol["kind"] }[] = [
  { re: /(?:^|\n)\s*(?:async\s+)?def\s+([A-Za-z_][\w]*)/, kind: "function" },
  { re: /(?:^|\n)\s*class\s+([A-Za-z_][\w]*)/, kind: "class" },
];

// ── Go ───────────────────────────────────────────────────────────────────

const GO_PATTERNS: { re: RegExp; kind: CodeSymbol["kind"] }[] = [
  { re: /(?:^|\n)func\s+(?:\([^)]*\)\s*)?([A-Za-z_][\w]*)\s*\(/, kind: "function" },
  { re: /(?:^|\n)type\s+([A-Za-z_][\w]*)\s+struct\s*\{/, kind: "class" },
  { re: /(?:^|\n)type\s+([A-Za-z_][\w]*)\s+interface\s*\{/, kind: "interface" },
];

// ── Rust ─────────────────────────────────────────────────────────────────

const RUST_PATTERNS: { re: RegExp; kind: CodeSymbol["kind"] }[] = [
  { re: /(?:^|\n)\s*(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_][\w]*)/, kind: "function" },
  { re: /(?:^|\n)\s*(?:pub\s+)?struct\s+([A-Za-z_][\w]*)/, kind: "class" },
  { re: /(?:^|\n)\s*(?:pub\s+)?trait\s+([A-Za-z_][\w]*)/, kind: "interface" },
  { re: /(?:^|\n)\s*(?:pub\s+)?enum\s+([A-Za-z_][\w]*)/, kind: "type" },
];

const PATTERNS_BY_LANG: Record<string, { re: RegExp; kind: CodeSymbol["kind"] }[]> = {
  typescript: TS_PATTERNS, javascript: TS_PATTERNS,
  python: PY_PATTERNS, go: GO_PATTERNS, rust: RUST_PATTERNS,
};

function lineOf(text: string, offset: number): number {
  return text.slice(0, offset).split("\n").length;
}

/** Extracts structural symbols from source text. Best-effort — never throws. */
export function extractSymbols(source: string, filePath: string): CodeSymbol[] {
  const language = languageOf(filePath);
  const symbols: CodeSymbol[] = [];
  const patterns = PATTERNS_BY_LANG[language];

  if (patterns) {
    for (const { re, kind } of patterns) {
      const r = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
      let m: RegExpExecArray | null;
      while ((m = r.exec(source)) !== null) {
        const startLine = lineOf(source, m.index);
        symbols.push({
          name: m[1],
          kind,
          language,
          startLine,
          endLine: startLine,
          signature: m[0].trim().slice(0, 120),
        });
      }
    }
  }

  // TypeScript/JavaScript class methods (indentation heuristic)
  if (language === "typescript" || language === "javascript") {
    let m: RegExpExecArray | null;
    const methodRe = new RegExp(TS_METHOD_RE.source, TS_METHOD_RE.flags);
    while ((m = methodRe.exec(source)) !== null) {
      const indent = m[1]?.length ?? 0;
      if (indent >= 2) {
        const name = m[2];
        if (!["if", "for", "while", "switch", "catch", "constructor", "get", "set"].includes(name)) {
          const startLine = lineOf(source, m.index);
          symbols.push({
            name,
            kind: "method",
            language,
            startLine,
            endLine: startLine,
            signature: m[0].trim().slice(0, 120),
          });
        }
      }
    }
  }

  // Imports/exports for reference tracking
  if (language === "typescript" || language === "javascript") {
    let m: RegExpExecArray | null;
    const impRe = new RegExp(TS_IMPORT_RE.source, TS_IMPORT_RE.flags);
    while ((m = impRe.exec(source)) !== null) {
      symbols.push({
        name: m[1],
        kind: "import",
        language,
        startLine: lineOf(source, m.index),
        endLine: lineOf(source, m.index),
        signature: m[0].trim().slice(0, 120),
      });
    }
  }

  // Deduplicate by name+kind+line
  const seen = new Set<string>();
  return symbols.filter((s) => {
    const key = `${s.name}:${s.kind}:${s.startLine}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Finds symbols matching a name query (exact, then prefix, then contains). */
export function findSymbols(symbols: CodeSymbol[], query: string): CodeSymbol[] {
  const q = query.toLowerCase();
  const exact = symbols.filter((s) => s.name.toLowerCase() === q && s.kind !== "import");
  if (exact.length > 0) return exact;
  const prefix = symbols.filter((s) => s.name.toLowerCase().startsWith(q) && s.kind !== "import");
  if (prefix.length > 0) return prefix;
  return symbols.filter((s) => s.name.toLowerCase().includes(q) && s.kind !== "import").slice(0, 10);
}
