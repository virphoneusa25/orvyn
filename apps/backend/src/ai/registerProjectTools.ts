// apps/backend/src/ai/registerProjectTools.ts
import { toolRegistry } from "./ToolTypes";
import { makeReadFileTool, makeListDirectoryTool, makeSearchFilesTool, makeWriteFileTool } from "./tools/fileTools";
import { makeTerminalTool } from "./tools/terminalTool";
import { makeGitStatusTool, makeGitDiffTool, makeGitCommitTool } from "./tools/gitTools";

let currentProjectRoot: string | null = null;

// Re-registering is cheap and idempotent, so callers (agent start, tools
// list, etc.) can call this defensively whenever they know the project root.
export function registerProjectTools(projectRoot: string): void {
  if (currentProjectRoot === projectRoot) return;
  toolRegistry.clear();
  toolRegistry.register(makeReadFileTool(projectRoot));
  toolRegistry.register(makeListDirectoryTool(projectRoot));
  toolRegistry.register(makeSearchFilesTool(projectRoot));
  toolRegistry.register(makeWriteFileTool(projectRoot));
  toolRegistry.register(makeTerminalTool(projectRoot));
  toolRegistry.register(makeGitStatusTool(projectRoot));
  toolRegistry.register(makeGitDiffTool(projectRoot));
  toolRegistry.register(makeGitCommitTool(projectRoot));
  currentProjectRoot = projectRoot;
}
