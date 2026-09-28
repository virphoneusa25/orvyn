// apps/backend/src/ai/tools/fileTools.ts
import { promises as fs } from "fs";
import * as path from "path";
import { AITool, ToolExecutionContext, ToolResult } from "../ToolTypes";

import { resolveSafePath } from "../../execution/pathSafety";
import { workspaceRootFor } from "../../execution/workspaceBinding";
import { verifyProjectFile } from "../../artifacts/projectFileEvidence";

// Every file tool resolves paths against the run workspace and refuses to
// escape it — this is the project-isolation boundary for Agent mode.
export function resolveSafe(projectRoot: string, relativePath: string): string {
  return resolveSafePath(projectRoot, relativePath);
}

function rootFor(registeredRoot: string, context?: ToolExecutionContext): string {
  return workspaceRootFor(registeredRoot, context);
}

function resolveInWorkspace(registeredRoot: string, relativePath: string, context?: ToolExecutionContext): string {
  return resolveSafePath(rootFor(registeredRoot, context), relativePath);
}

const IGNORE_DIRS = new Set(["node_modules", ".git", "dist", "build", "coverage", ".orvyn"]);

export function makeReadFileTool(projectRoot: string): AITool {
  return {
    name: "read_file",
    description: "Read a file inside this run's workspace. Pass a relative path such as index.html. Host paths and .. are refused.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
    defaultPermission: "allowed",
    async execute(args, context): Promise<ToolResult> {
      try {
        const target = resolveInWorkspace(projectRoot, String(args.path), context);
        // encoding "base64" (not offered to the model): ORVYN reading an image
        // or font the live preview needs, byte for byte.
        if (args.encoding === "base64") return { ok: true, output: (await fs.readFile(target)).toString("base64") };
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
    description: "List files and folders inside this run's workspace. Paths are relative to that workspace.",
    parameters: {
      type: "object",
      properties: { path: { type: "string", default: "." } },
    },
    defaultPermission: "allowed",
    async execute(args, context): Promise<ToolResult> {
      try {
        const target = resolveInWorkspace(projectRoot, String(args.path ?? "."), context);
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
    async execute(args, context): Promise<ToolResult> {
      try {
        const target = resolveInWorkspace(projectRoot, String(args.path), context);
        let existed = false;
        try { await fs.access(target); existed = true; } catch { /* new file */ }
        // Destructive-rewrite guard: a write that would replace a substantial
        // existing file with far less content (a "small task" deleting
        // hundreds of lines) is rejected — targeted changes must use
        // edit_file. Thresholds are generous so legitimate full rewrites of
        // small files are never blocked.
        if (existed && typeof args.content === "string" && !args.content_base64) {
          const previous = await fs.readFile(target, "utf8").catch(() => "");
          const oldLines = previous ? previous.split("\n").length : 0;
          const newLines = args.content.split("\n").length;
          const deletions = oldLines - newLines;
          const threshold = Number(process.env.ORVYN_MAX_UNINTENDED_DELETIONS || 300);
          if (oldLines >= 80 && deletions >= threshold) {
            return {
              ok: false,
              error: `This write would replace ${args.path} (${oldLines} lines) with ${newLines} lines — deleting ${deletions} lines for what should be a targeted change. Use edit_file with the exact old_string/new_string instead. If a full rewrite is truly intended, apply it with edit_file using replace_all on the sections that change, or state the justification and rewrite deliberately section by section.`,
              meta: { code: "DESTRUCTIVE_REWRITE", path: String(args.path), oldLines, newLines, deletions },
            };
          }
        }
        await fs.mkdir(path.dirname(target), { recursive: true });
        // content_base64 (not offered to the model): ORVYN saving a file the
        // user attached (a logo, a photo) into the project, byte for byte.
        const binary = typeof args.content_base64 === "string" && args.content_base64.length > 0;
        const expected = binary ? Buffer.from(String(args.content_base64), "base64") : Buffer.from(String(args.content), "utf-8");
        await fs.writeFile(target, expected);
        const projectFileEvidence = await verifyProjectFile(rootFor(projectRoot, context), String(args.path), expected);
        const lines = binary ? 1 : String(args.content).split("\n").length;
        return { ok: true, output: `${existed ? "OVERWROTE" : "CREATED"} ${args.path} (${lines} lines, ${projectFileEvidence.size} bytes, sha256 ${projectFileEvidence.sha256})`, projectFileEvidence };
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
    async execute(args, context): Promise<ToolResult> {
      try {
        const results = await searchFiles(rootFor(projectRoot, context), String(args.query));
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
    async execute(args, context): Promise<ToolResult> {
      try {
        const target = resolveInWorkspace(projectRoot, String(args.path), context);
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
        const expected = Buffer.from(next, "utf-8");
        await fs.writeFile(target, expected);
        const projectFileEvidence = await verifyProjectFile(rootFor(projectRoot, context), String(args.path), expected);
        const applied = replaceAll ? count : 1;
        const added = next.split("\n").length - original.split("\n").length;
        return {
          ok: true,
          output: `EDITED ${args.path} — ${applied} replacement${applied === 1 ? "" : "s"} (${added >= 0 ? "+" : "−"}${Math.abs(added)} lines)`,
          projectFileEvidence,
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
    async execute(args, context): Promise<ToolResult> {
      try {
        const target = resolveInWorkspace(projectRoot, String(args.path), context);
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
    async execute(args, context): Promise<ToolResult> {
      try {
        const src = resolveInWorkspace(projectRoot, String(args.from), context);
        const dest = resolveInWorkspace(projectRoot, String(args.to), context);
        await fs.mkdir(path.dirname(dest), { recursive: true });
        await fs.rename(src, dest);
        return { ok: true, output: `Moved ${args.from} → ${args.to}` };
      } catch (err: any) {
        return { ok: false, error: err.message };
      }
    },
  };
}

export function makeApplyPatchTool(projectRoot: string): AITool {
  return {
    name: "apply_patch",
    description: "Replace a file inside this run's workspace. The path is relative to the workspace. Host paths and .. are refused.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string", description: "Full new contents of the file" },
        patch: { type: "string", description: "Full new contents when content is omitted" },
      },
      required: ["path"],
    },
    defaultPermission: "ask",
    async execute(args, context): Promise<ToolResult> {
      try {
        const target = resolveInWorkspace(projectRoot, String(args.path), context);
        const body = args.content != null ? String(args.content) : args.patch != null ? String(args.patch) : "";
        if (!body) return { ok: false, error: "apply_patch needs content or patch, and the path must stay inside the workspace." };
        if (/(^|\n)(?:\+\+\+|---)\s+\S*\.\.([\\/]|$)/.test(body)) {
          return { ok: false, error: "Patch escapes the project root — refused" };
        }
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, body, "utf-8");
        return { ok: true, output: `PATCHED ${args.path}` };
      } catch (err: any) {
        return { ok: false, error: err.message };
      }
    },
  };
}
