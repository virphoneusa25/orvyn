// Project intelligence tools — HybridSearch + Qdrant via IndexService.
// Snippets are retrieval hints. ORION must read the live file before editing.

import type { AITool, ToolResult } from "../ToolTypes";
import type { IndexService } from "../../indexing/IndexService";
import type { HybridSearch } from "../../indexing/HybridSearch";

function formatHits(hits: { path: string; startLine?: number; endLine?: number; snippet?: string; score?: number; symbol?: string; matchedBy?: string[] }[]): string {
  if (hits.length === 0) return "(no matches)";
  return hits
    .map((h) => {
      const loc = h.startLine ? `${h.path}:${h.startLine}${h.endLine && h.endLine !== h.startLine ? "-" + h.endLine : ""}` : h.path;
      const why = h.matchedBy?.length ? ` [${h.matchedBy.join(", ")}]` : "";
      const sym = h.symbol ? ` ${h.symbol}` : "";
      const snip = h.snippet ? `\n${String(h.snippet).slice(0, 180)}` : "";
      return `${loc}${sym} score=${(h.score ?? 0).toFixed(2)}${why}${snip}`;
    })
    .join("\n---\n");
}

function hybridOf(index: IndexService): HybridSearch | null {
  return index.hybridSearch;
}

export function makeSearchCodebaseTool(index: IndexService, projectRoot: string): AITool {
  return {
    name: "search_codebase",
    description:
      "Hybrid project search (symbols + keywords + semantic). Use this BEFORE brute-force grep or listing the repo. Returns paths, line ranges, snippets, and match reasons. Snippets are not source of truth — read_file the live file before editing.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
        path: { type: "string", description: "Optional path prefix scope" },
        language: { type: "string" },
        limit: { type: "number" },
      },
      required: ["query"],
    },
    defaultPermission: "allowed",
    async execute(args): Promise<ToolResult> {
      const query = String(args.query ?? "").trim();
      if (!query) return { ok: false, error: "query is required" };
      if (index.getStats().status === "idle") {
        await index.build(projectRoot).catch(() => undefined);
      }
      const limit = Math.min(20, Math.max(1, Number(args.limit) || 8));
      try {
        const hits = await index.searchHybrid(query, limit * 2);
        const scoped = hits.filter((h) => {
          if (args.path && !h.path.replace(/\\/g, "/").startsWith(String(args.path).replace(/\\/g, "/"))) return false;
          return true;
        }).slice(0, limit);
        return { ok: true, output: formatHits(scoped) };
      } catch (err: any) {
        return { ok: false, error: err.message };
      }
    },
  };
}

export function makeFindSymbolTool(index: IndexService, projectRoot: string): AITool {
  return {
    name: "find_symbol",
    description: "Find a function/class/interface by name using structural symbols. Prefer this over grep when you know the identifier.",
    parameters: {
      type: "object",
      properties: { name: { type: "string" }, query: { type: "string" } },
      required: [],
    },
    defaultPermission: "allowed",
    async execute(args): Promise<ToolResult> {
      const name = String(args.name ?? args.query ?? "").trim();
      if (!name) return { ok: false, error: "name is required" };
      if (!index.hybridSearch) index.bindProject(projectRoot);
      const hs = hybridOf(index);
      if (!hs) return { ok: false, error: "project search is not bound" };
      const hits = await hs.findSymbol(name);
      return { ok: true, output: formatHits(hits) };
    },
  };
}

export function makeFindFileTool(index: IndexService, projectRoot: string): AITool {
  return {
    name: "find_file",
    description: "Fast filename/path lookup. Use for 'open connection.ts' — do not embed a whole-repo search.",
    parameters: {
      type: "object",
      properties: { query: { type: "string" }, name: { type: "string" } },
    },
    defaultPermission: "allowed",
    async execute(args): Promise<ToolResult> {
      const query = String(args.query ?? args.name ?? "").trim();
      if (!query) return { ok: false, error: "query is required" };
      if (!index.hybridSearch) index.bindProject(projectRoot);
      const hs = hybridOf(index);
      if (!hs) return { ok: false, error: "project search is not bound" };
      const files = await hs.findFile(query);
      return { ok: true, output: files.join("\n") || "(no files)" };
    },
  };
}

export function makeRelatedFilesTool(index: IndexService, projectRoot: string): AITool {
  return {
    name: "related_files",
    description: "Files related to a path via imports, shared symbols, tests, and folder proximity.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
    defaultPermission: "allowed",
    async execute(args): Promise<ToolResult> {
      const target = String(args.path ?? "").trim();
      if (!target) return { ok: false, error: "path is required" };
      if (!index.hybridSearch) index.bindProject(projectRoot);
      const hs = hybridOf(index);
      if (!hs) return { ok: false, error: "project search is not bound" };
      const related = await hs.relatedFiles(target);
      const tests = await hs.searchTests(target);
      const lines = [
        related.length ? `related:\n${related.join("\n")}` : "related: (none)",
        tests.length ? `tests:\n${tests.join("\n")}` : "tests: (none)",
      ];
      return { ok: true, output: lines.join("\n") };
    },
  };
}

export function makeSearchTestsTool(index: IndexService, projectRoot: string): AITool {
  return {
    name: "search_tests",
    description: "Find likely tests for a source file (*.test.*, *.spec.*, tests/).",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
    defaultPermission: "allowed",
    async execute(args): Promise<ToolResult> {
      const target = String(args.path ?? "").trim();
      if (!target) return { ok: false, error: "path is required" };
      if (!index.hybridSearch) index.bindProject(projectRoot);
      const hs = hybridOf(index);
      if (!hs) return { ok: false, error: "project search is not bound" };
      const tests = await hs.searchTests(target);
      return { ok: true, output: tests.join("\n") || "(no tests found)" };
    },
  };
}

export function makeProjectOutlineTool(index: IndexService, projectRoot: string): AITool {
  return {
    name: "get_project_outline",
    description: "Lightweight project outline: top directories, configs, entry points. Not a full file tree.",
    parameters: { type: "object", properties: {} },
    defaultPermission: "allowed",
    async execute(): Promise<ToolResult> {
      if (!index.hybridSearch) index.bindProject(projectRoot);
      const hs = hybridOf(index);
      if (!hs) return { ok: false, error: "project search is not bound" };
      const outline = await hs.outline();
      return {
        ok: true,
        output: [
          `directories: ${outline.directories.join(", ") || "(none)"}`,
          `entry points: ${outline.entryPoints.join(", ") || "(none)"}`,
          `config: ${outline.configs.join(", ") || "(none)"}`,
        ].join("\n"),
      };
    },
  };
}
