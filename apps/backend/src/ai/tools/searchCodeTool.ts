// Content search (grep). Filename search is search_files; this is the one
// that finds validateToken when the agent only knows the string.
import { spawn } from "child_process";
import { promises as fs } from "fs";
import * as path from "path";
import { AITool, ToolResult } from "../ToolTypes";
import { resolveSafe } from "./fileTools";

const IGNORE_DIRS = new Set(["node_modules", ".git", "dist", "build", "coverage", ".orvyn", ".next", "release"]);
const SKIP_EXT = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".pdf", ".zip", ".gz", ".woff", ".woff2",
  ".exe", ".dll", ".bin", ".map", ".lock",
]);
const MAX_FILE_BYTES = 512 * 1024;

export function makeSearchCodeTool(projectRoot: string): AITool {
  return {
    name: "search_code",
    description:
      "Grep file contents for a regex/string. Returns path:line:text. Use this to find symbols, error strings, and call sites — do not guess filenames.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Regex or literal substring" },
        path: { type: "string", description: "Subdirectory or file to search (default project root)" },
        glob: { type: "string", description: "Filename glob, e.g. *.ts or *.{ts,tsx}" },
        case_insensitive: { type: "boolean" },
        max_results: { type: "number", description: "Cap (default 50)" },
      },
      required: ["pattern"],
    },
    defaultPermission: "allowed",
    async execute(args): Promise<ToolResult> {
      try {
        const pattern = String(args.pattern ?? "");
        if (!pattern) return { ok: false, error: "pattern is required" };
        const rel = String(args.path ?? ".");
        const root = resolveSafe(projectRoot, rel);
        const glob = args.glob ? String(args.glob) : undefined;
        const insensitive = args.case_insensitive === true;
        const max = Math.min(200, Math.max(1, Number(args.max_results) || 50));

        const rg = await ripgrep(root, pattern, { glob, insensitive, max });
        if (rg !== null) {
          return { ok: true, output: rg || "(no matches)" };
        }
        const fallback = await walkGrep(root, projectRoot, pattern, { glob, insensitive, max });
        return { ok: true, output: fallback || "(no matches)" };
      } catch (err: any) {
        return { ok: false, error: err.message };
      }
    },
  };
}

function ripgrep(
  cwd: string,
  pattern: string,
  opts: { glob?: string; insensitive: boolean; max: number }
): Promise<string | null> {
  return new Promise((resolve) => {
    const args = ["--line-number", "--no-heading", "--color", "never", "--max-count", String(opts.max)];
    if (opts.insensitive) args.push("-i");
    if (opts.glob) args.push("--glob", opts.glob);
    args.push("--", pattern, ".");
    const child = spawn("rg", args, { cwd, windowsHide: true });
    let stdout = "";
    let settled = false;
    child.stdout?.on("data", (d) => {
      stdout += d.toString("utf-8");
    });
    child.on("error", () => {
      if (!settled) {
        settled = true;
        resolve(null);
      }
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      if (code !== 0 && code !== 1) {
        resolve(null);
        return;
      }
      const lines = stdout.split(/\r?\n/).filter(Boolean).slice(0, opts.max);
      resolve(lines.join("\n"));
    });
  });
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "i");
}

async function walkGrep(
  dir: string,
  projectRoot: string,
  pattern: string,
  opts: { glob?: string; insensitive: boolean; max: number }
): Promise<string> {
  const hits: string[] = [];
  let regex: RegExp;
  try {
    regex = new RegExp(pattern, opts.insensitive ? "i" : "");
  } catch {
    regex = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), opts.insensitive ? "i" : "");
  }
  const fileFilter = opts.glob ? globToRegExp(opts.glob) : null;

  async function walk(current: string): Promise<void> {
    if (hits.length >= opts.max) return;
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (hits.length >= opts.max) return;
      if (IGNORE_DIRS.has(entry.name)) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      const ext = path.extname(entry.name).toLowerCase();
      if (SKIP_EXT.has(ext)) continue;
      if (fileFilter && !fileFilter.test(entry.name)) continue;
      try {
        const st = await fs.stat(full);
        if (st.size > MAX_FILE_BYTES) continue;
        const text = await fs.readFile(full, "utf-8");
        if (text.includes("\0")) continue;
        const rel = path.relative(projectRoot, full);
        const lines = text.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          if (hits.length >= opts.max) return;
          if (regex.test(lines[i])) hits.push(`${rel}:${i + 1}:${lines[i]}`);
        }
      } catch {
        // unreadable / binary
      }
    }
  }

  await walk(dir);
  return hits.join("\n");
}
