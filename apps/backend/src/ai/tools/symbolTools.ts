// apps/backend/src/ai/tools/symbolTools.ts
//
// v1 symbol listing: regex over source text. This is the stand-in for a real
// search_symbols until tree-sitter / LSP land (Context Engine pending items).

import { promises as fs } from "fs";
import * as path from "path";
import { AITool, ToolResult } from "../ToolTypes";
import { resolveSafe } from "./fileTools";

interface FoundSymbol {
  kind: string;
  name: string;
  line: number;
}

const PATTERNS: { kind: string; re: RegExp }[] = [
  { kind: "class", re: /^\s*(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/ },
  { kind: "interface", re: /^\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/ },
  { kind: "type", re: /^\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*=/ },
  { kind: "enum", re: /^\s*(?:export\s+)?(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)/ },
  { kind: "function", re: /^\s*(?:export\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/ },
  { kind: "const", re: /^\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\(|function)/ },
  { kind: "method", re: /^\s{2,}(?:public\s+|private\s+|protected\s+|static\s+|readonly\s+)*(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::[^{]+)?\{\s*$/ },
  // Python
  { kind: "class", re: /^\s*class\s+([A-Za-z_][\w]*)/ },
  { kind: "function", re: /^\s*(?:async\s+)?def\s+([A-Za-z_][\w]*)/ },
  // PHP
  { kind: "function", re: /^\s*(?:public|private|protected|static|\s)*function\s+([A-Za-z_][\w]*)/ },
];

function scan(text: string): FoundSymbol[] {
  const out: FoundSymbol[] = [];
  const seen = new Set<string>();
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    for (const { kind, re } of PATTERNS) {
      const m = re.exec(lines[i]);
      if (m) {
        const key = `${m[1]}:${i}`;
        if (!seen.has(key)) {
          seen.add(key);
          out.push({ kind, name: m[1], line: i + 1 });
        }
        break;
      }
    }
  }
  return out;
}

export function makeListSymbolsTool(projectRoot: string): AITool {
  return {
    name: "list_symbols",
    description:
      "List the classes, functions, interfaces, types and methods defined in a source file, with line numbers. Regex-based (no LSP): good for orientation, not for exact references.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path relative to the project root" },
      },
      required: ["path"],
    },
    defaultPermission: "allowed",
    async execute(args): Promise<ToolResult> {
      try {
        const abs = resolveSafe(projectRoot, String(args.path ?? ""));
        const stat = await fs.stat(abs);
        if (!stat.isFile()) return { ok: false, error: "Not a file" };
        if (stat.size > 1024 * 1024) return { ok: false, error: "File too large (>1MB)" };
        const text = await fs.readFile(abs, "utf8");
        const symbols = scan(text);
        if (symbols.length === 0) return { ok: true, output: "(no symbols found)" };
        const rel = path.relative(projectRoot, abs).replace(/\\/g, "/");
        return {
          ok: true,
          output: symbols.map((s) => `${rel}:${s.line}: ${s.kind} ${s.name}`).join("\n"),
        };
      } catch (err: any) {
        return { ok: false, error: err.message };
      }
    },
  };
}
