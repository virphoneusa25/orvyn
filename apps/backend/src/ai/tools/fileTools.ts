// apps/backend/src/ai/tools/fileTools.ts
import { promises as fs } from "fs";
import * as path from "path";
import { AITool, ToolResult } from "../ToolTypes";

// Every file tool resolves paths against a project root and refuses to
// escape it — this is the project-isolation boundary for Agent mode.
export function resolveSafe(projectRoot: string, relativePath: string): string {
  const resolved = path.resolve(projectRoot, relativePath);
  if (!resolved.startsWith(path.resolve(projectRoot))) {
    throw new Error(`Path "${relativePath}" escapes the project root — refused`);
  }
  return resolved;
}

const IGNORE_DIRS = new Set(["node_modules", ".git", "dist", "build", "coverage", ".orvyn"]);

export function makeReadFileTool(projectRoot: string): AITool {
  return {
    name: "read_file",
    description: "Read the contents of a file within the current project.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
    defaultPermission: "allowed",
    async execute(args): Promise<ToolResult> {
      try {
        const target = resolveSafe(projectRoot, String(args.path));
        const content = await fs.readFile(target, "utf-8");
        return { ok: true, output: content };
      } catch (err: any) {
        return { ok: false, error: err.message };
      }
    },
  };
}

export function makeListDirectoryTool(projectRoot: string): AITool {
  return {
    name: "list_directory",
    description: "List files and folders at a path within the current project.",
    parameters: {
      type: "object",
      properties: { path: { type: "string", default: "." } },
    },
    defaultPermission: "allowed",
    async execute(args): Promise<ToolResult> {
      try {
        const target = resolveSafe(projectRoot, String(args.path ?? "."));
        const entries = await fs.readdir(target, { withFileTypes: true });
        const filtered = entries
          .filter((e) => !IGNORE_DIRS.has(e.name))
          .map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
        return { ok: true, output: filtered.join("\n") };
      } catch (err: any) {
        return { ok: false, error: err.message };
      }
    },
  };
}

export function makeWriteFileTool(projectRoot: string): AITool {
  return {
    name: "write_file",
    description:
      "Create or fully overwrite a file. Prefer edit_file for changing an existing file — write_file clobbers the whole file.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
    },
    // Matches the master spec: write access defaults to "ask", not "allowed".
    defaultPermission: "ask",
    async execute(args): Promise<ToolResult> {
      try {
        const target = resolveSafe(projectRoot, String(args.path));
        let existed = false;
        try { await fs.access(target); existed = true; } catch { /* new file */ }
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, String(args.content), "utf-8");
        const lines = String(args.content).split("\n").length;
        return { ok: true, output: `${existed ? "OVERWROTE" : "CREATED"} ${args.path} (${lines} lines)` };
      } catch (err: any) {
        return { ok: false, error: err.message };
      }
    },
  };
}

export async function searchFiles(
  projectRoot: string,
  query: string,
  maxResults = 50
): Promise<string[]> {
  const matches: string[] = [];

  async function walk(dir: string): Promise<void> {
    if (matches.length >= maxResults) return;
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (matches.length >= maxResults) return;
      if (IGNORE_DIRS.has(entry.name)) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.name.toLowerCase().includes(query.toLowerCase())) {
        matches.push(path.relative(projectRoot, fullPath));
      }
    }
  }

  await walk(projectRoot);
  return matches;
}

export function makeSearchFilesTool(projectRoot: string): AITool {
  return {
    name: "search_files",
    description:
      "Find files by filename substring only (not file contents). Use search_code to grep inside files.",
    parameters: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    },
    defaultPermission: "allowed",
    async execute(args): Promise<ToolResult> {
      try {
        const results = await searchFiles(projectRoot, String(args.query));
        return { ok: true, output: results.join("\n") || "(no matches)" };
      } catch (err: any) {
        return { ok: false, error: err.message };
      }
    },
  };
}

export function makeEditFileTool(projectRoot: string): AITool {
  return {
    name: "edit_file",
    description:
      "Surgically replace exact text in an existing file. old_string must match uniquely unless replace_all is true. Use this instead of write_file when changing a few lines.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        old_string: { type: "string", description: "Exact text to find" },
        new_string: { type: "string", description: "Replacement text" },
        replace_all: { type: "boolean", description: "Replace every occurrence (default false)" },
      },
      required: ["path", "old_string", "new_string"],
    },
    defaultPermission: "ask",
    async execute(args): Promise<ToolResult> {
      try {
        const target = resolveSafe(projectRoot, String(args.path));
        const oldString = String(args.old_string);
        const newString = String(args.new_string);
        if (!oldString) return { ok: false, error: "old_string must not be empty" };
        const original = await fs.readFile(target, "utf-8");
        let count = 0;
        let idx = 0;
        while ((idx = original.indexOf(oldString, idx)) !== -1) {
          count++;
          idx += oldString.length;
        }
        if (count === 0) {
          return { ok: false, error: `old_string not found in ${args.path}` };
        }
        const replaceAll = args.replace_all === true;
        if (count > 1 && !replaceAll) {
          return {
            ok: false,
            error: `old_string matched ${count} times in ${args.path}. Pass replace_all=true or include more surrounding context to make it unique.`,
          };
        }
        const next = replaceAll ? original.split(oldString).join(newString) : original.replace(oldString, newString);
        await fs.writeFile(target, next, "utf-8");
        const applied = replaceAll ? count : 1;
        const added = next.split("\n").length - original.split("\n").length;
        return {
          ok: true,
          output: `EDITED ${args.path} — ${applied} replacement${applied === 1 ? "" : "s"} (${added >= 0 ? "+" : "−"}${Math.abs(added)} lines)`,
        };
      } catch (err: any) {
        return { ok: false, error: err.message };
      }
    },
  };
}

export function makeDeleteFileTool(projectRoot: string): AITool {
  return {
    name: "delete_file",
    description: "Delete a file within the current project. Directories are refused. Requires approval.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
    defaultPermission: "ask",
    async execute(args): Promise<ToolResult> {
      try {
        const target = resolveSafe(projectRoot, String(args.path));
        const stat = await fs.stat(target);
        if (stat.isDirectory()) return { ok: false, error: "Refusing to delete a directory — delete files individually" };
        await fs.unlink(target);
        return { ok: true, output: `Deleted ${args.path}` };
      } catch (err: any) {
        return { ok: false, error: err.message };
      }
    },
  };
}

export function makeMoveFileTool(projectRoot: string): AITool {
  return {
    name: "move_file",
    description: "Move or rename a file within the current project. Requires approval.",
    parameters: {
      type: "object",
      properties: {
        from: { type: "string" },
        to: { type: "string" },
      },
      required: ["from", "to"],
    },
    defaultPermission: "ask",
    async execute(args): Promise<ToolResult> {
      try {
        const src = resolveSafe(projectRoot, String(args.from));
        const dest = resolveSafe(projectRoot, String(args.to));
        await fs.mkdir(path.dirname(dest), { recursive: true });
        await fs.rename(src, dest);
        return { ok: true, output: `Moved ${args.from} → ${args.to}` };
      } catch (err: any) {
        return { ok: false, error: err.message };
      }
    },
  };
}
