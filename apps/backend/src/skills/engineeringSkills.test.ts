import { test } from "node:test";
import assert from "node:assert/strict";
import { ToolRegistry } from "../ai/ToolTypes";
import { ToolGateway } from "../gateway/ToolGateway";
import { PermissionEngine } from "../gateway/PermissionEngine";
import { makeReadDocumentTool, makeCreateDocumentTool, makeCreateZipTool } from "../ai/tools/documentTools";
import { registerArtifactTools } from "../ai/tools/artifactTools";
import {
  makeReadFileTool,
  makeListDirectoryTool,
  makeSearchFilesTool,
  makeWriteFileTool,
  makeEditFileTool,
  makeDeleteFileTool,
  makeMoveFileTool,
} from "../ai/tools/fileTools";
import { makeSearchCodeTool } from "../ai/tools/searchCodeTool";
import {
  makeFindFileTool,
  makeFindSymbolTool,
  makeProjectOutlineTool,
  makeRelatedFilesTool,
  makeSearchCodebaseTool,
  makeSearchTestsTool,
} from "../ai/tools/projectIntelligenceTools";
import { makeListSymbolsTool } from "../ai/tools/symbolTools";
import { makeTerminalTool } from "../ai/tools/terminalTool";
import {
  makeGitStatusTool,
  makeGitDiffTool,
  makeGitCommitTool,
  makeGitLogTool,
  makeGitBranchTool,
  makeGitCheckoutTool,
} from "../ai/tools/gitTools";
import { makeGenerateImageTool } from "../ai/tools/imageTool";
import { makeFetchUrlTool, makeWebSearchTool } from "../ai/tools/netTools";
import { makeSshExecTool } from "../ai/tools/sshTools";
import { makeMcpListTool, makeMcpCallTool } from "../ai/tools/mcpTools";
import { makeSearchCapabilitiesTool, makeInstallMcpServerTool } from "../ai/tools/searchCapabilities";
import {
  makeBrowserOpenTool,
  makeBrowserNavigateTool,
  makeBrowserClickTool,
  makeBrowserTypeTool,
  makeBrowserScreenshotTool,
  makeBrowserConsoleErrorsTool,
  makeBrowserScrollTool,
  makeBrowserEvidenceTool,
  makeBrowserViewportTool,
} from "../ai/tools/browserTools";
import { registerDesktopTools } from "../ai/tools/desktopTools";
import { registerHostDesktopTools } from "../ai/tools/hostDesktopTools";
import { registerComputerUseTools } from "../computerUse/computerUseTools";
import {
  makeGetDiagnosticsTool,
  makeRunTypecheckTool,
  makeRunTestsTool,
  makeRunLinterTool,
} from "../ai/tools/diagnosticsTools";
import {
  makeStartProcessTool,
  makeStopProcessTool,
  makeReadProcessLogsTool,
  makeListProcessesTool,
} from "../ai/tools/processTools";
import { SkillLoader, builtinSkillsRoot } from "./SkillLoader";
import { matchValidatedSkills, skillsPromptFor } from "../learning/validatedSkills";

/** Same tool names registerProjectToolsFor puts on the gateway, without a tenant. */
function registeredToolNames(): Set<string> {
  const gateway = new ToolGateway(new ToolRegistry(), new PermissionEngine());
  const root = process.cwd();
  const index = {} as never;
  const artifacts = {} as never;
  const register = (tool: { name: string }) => gateway.register(tool as never);
  register(makeReadDocumentTool(root));
  register(makeCreateDocumentTool(root, artifacts));
  register(makeCreateZipTool(artifacts));
  registerArtifactTools(register, artifacts);
  register(makeReadFileTool(root));
  register(makeListDirectoryTool(root));
  register(makeSearchFilesTool(root));
  register(makeSearchCodeTool(root));
  register(makeSearchCodebaseTool(index, root));
  register(makeFindSymbolTool(index, root));
  register(makeFindFileTool(index, root));
  register(makeRelatedFilesTool(index, root));
  register(makeSearchTestsTool(index, root));
  register(makeProjectOutlineTool(index, root));
  register(makeListSymbolsTool(root));
  register(makeWriteFileTool(root));
  register(makeEditFileTool(root));
  register(makeMoveFileTool(root));
  register(makeDeleteFileTool(root));
  register(makeTerminalTool(root));
  gateway.registerAlias("run_command", "terminal");
  register(makeStartProcessTool(root));
  register(makeStopProcessTool(root));
  register(makeReadProcessLogsTool(root));
  register(makeListProcessesTool(root));
  register(makeGetDiagnosticsTool(root));
  register(makeRunTypecheckTool(root));
  register(makeRunTestsTool(root));
  register(makeRunLinterTool(root));
  register(makeFetchUrlTool());
  register(makeWebSearchTool());
  register(makeSshExecTool(root));
  register(makeBrowserOpenTool(root));
  register(makeBrowserNavigateTool(root));
  register(makeBrowserClickTool(root));
  register(makeBrowserTypeTool(root));
  register(makeBrowserScrollTool(root));
  register(makeBrowserViewportTool(root));
  register(makeBrowserScreenshotTool(root));
  register(makeBrowserConsoleErrorsTool(root));
  register(makeBrowserEvidenceTool(root));
  registerDesktopTools(register, root, "tenant");
  registerHostDesktopTools(register, "tenant");
  registerComputerUseTools(register, (alias, target) => gateway.registerAlias(alias, target), root, "tenant", artifacts);
  register(makeGitStatusTool(root));
  register(makeGitDiffTool(root));
  register(makeGitLogTool(root));
  register(makeGitBranchTool(root));
  register(makeGitCheckoutTool(root));
  register(makeGitCommitTool(root));
  register(makeGenerateImageTool(root, {} as never, artifacts));
  register(makeMcpListTool({} as never, root));
  register(makeMcpCallTool({} as never, root));
  register(makeSearchCapabilitiesTool(() => ({} as never)));
  register(makeInstallMcpServerTool(() => ({} as never)));
  return new Set(gateway.list().map((tool) => tool.name));
}

const ORIGINAL = ["skill_deliver_file", "skill_code_with_tests", "skill_visual_verify"];

test("engineering built-ins load and reference only registered tools", () => {
  const report = new SkillLoader(builtinSkillsRoot()).load();
  assert.deepEqual(report.rejected, []);
  const ids = report.skills.map((skill) => skill.id);
  const slugs = report.skills.map((skill) => skill.metadata.slug);
  assert.deepEqual(new Set(ids).size, ids.length);
  assert.deepEqual(new Set(slugs).size, slugs.length);
  for (const id of ORIGINAL) assert.ok(ids.includes(id), id);

  const engineering = report.skills.filter((skill) => skill.metadata.category === "Engineering");
  assert.equal(engineering.length, 12);
  assert.equal(report.skills.length, 15);
  const tools = registeredToolNames();
  for (const skill of engineering) {
    assert.equal(skill.metadata.publisher, "Kernel AI Labs");
    assert.equal(skill.metadata.source, "builtin");
    assert.equal(skill.metadata.builtIn, true);
    assert.equal(skill.metadata.trusted, true);
    assert.equal(skill.metadata.scope, "builtin");
    assert.match(skill.metadata.version, /^\d+\.\d+\.\d+$/);
    assert.ok(skill.metadata.validation.rule.trim());
    const referenced = [...skill.metadata.requiredTools, ...skill.metadata.optionalTools];
    const unknown = referenced.filter((name) => !tools.has(name));
    assert.deepEqual(unknown, [], `${skill.name} references unknown tools: ${unknown.join(", ")}`);
    const permissionIds = skill.metadata.permissionsRequired.map((item) => item.id);
    assert.deepEqual([...permissionIds].sort(), [...referenced].sort());
  }

  assert.deepEqual(matchValidatedSkills("Generate a virphone logo in png format").map((skill) => skill.id), ["skill_deliver_file"]);
  assert.deepEqual(matchValidatedSkills("Fix the failing tests").map((skill) => skill.id), ["skill_code_with_tests"]);
  assert.deepEqual(matchValidatedSkills("The dashboard layout overflows").map((skill) => skill.id), ["skill_visual_verify"]);
  assert.equal(skillsPromptFor("What time is it?"), "");
});
