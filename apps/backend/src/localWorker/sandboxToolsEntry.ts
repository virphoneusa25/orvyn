// Runs INSIDE the Desktop container. Reuses the same project tools and schemas.
import { makeReadFileTool, makeWriteFileTool, makeEditFileTool, makeListDirectoryTool, makeSearchFilesTool } from "../ai/tools/fileTools";
import { makeTerminalTool } from "../ai/tools/terminalTool";
import { makeRunTestsTool, makeRunTypecheckTool } from "../ai/tools/diagnosticsTools";
import { makeSearchCodeTool } from "../ai/tools/searchCodeTool";
import { makeGitStatusTool, makeGitDiffTool, makeGitLogTool } from "../ai/tools/gitTools";

const root = "/workspace";
const tools = { read_file: makeReadFileTool(root), write_file: makeWriteFileTool(root), edit_file: makeEditFileTool(root),
  list_directory: makeListDirectoryTool(root), search_files: makeSearchFilesTool(root), search_code: makeSearchCodeTool(root),
  search_codebase: makeSearchCodeTool(root), terminal: makeTerminalTool(root), run_command: makeTerminalTool(root),
  run_tests: makeRunTestsTool(root), run_typecheck: makeRunTypecheckTool(root), git_status: makeGitStatusTool(root), git_diff: makeGitDiffTool(root), git_log: makeGitLogTool(root) };

async function main() {
  const req = JSON.parse(Buffer.from(process.argv[2], "base64").toString("utf8"));
  const tool = tools[req.tool as keyof typeof tools];
  const result = tool ? await tool.execute(req.arguments ?? {}) : { ok: false, error: `Tool ${req.tool} is unavailable in the project sandbox` };
  process.stdout.write("\nORVYN_TOOL_RESULT:" + JSON.stringify(result) + "\n");
}
void main().catch(() => { process.stdout.write('\nORVYN_TOOL_RESULT:{"ok":false,"error":"Sandbox tool execution failed"}\n'); process.exitCode = 1; });
