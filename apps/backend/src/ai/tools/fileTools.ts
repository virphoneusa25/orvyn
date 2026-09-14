// apps/backend/src/ai/tools/fileTools.ts
import { promises as fs } from "fs";
import * as path from "path";
import { AITool, ToolResult } from "../ToolTypes";

// Every file tool resolves paths against a project root and refuses to
// escape it — this is the project-isolation boundary for Agent mode.
function resolveSafe(projectRoot: string, relativePath: string): string {
  const resolved = path.resolve(projectRoot, relativePath);
  if (!resolved.startsWith(path.resolve(projectRoot))) {
    throw new Error(`Path "${relativePath}" escapes the project root — refused`);
  }
  return resolved;
}

const IGNORE_DIRS = new Set(["node_modules", ".git", "dist", "build", "coverage", ".viride"]);

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
    description: "Create or overwrite a file within the current project. Requires user approval.",
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
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, String(args.content), "utf-8");
        return { ok: true, output: `Wrote ${args.path}` };
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
    description: "Search for files by filename substring within the current project.",
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
