import { makeReadDocumentTool, makeCreateDocumentTool, makeCreateZipTool } from "./tools/documentTools";
// apps/backend/src/ai/registerProjectTools.ts
import type { Tenant } from "../tenancy/TenantManager";
import type { ToolPermission } from "./ToolTypes";
import {
  makeReadFileTool,
  makeListDirectoryTool,
  makeSearchFilesTool,
  makeWriteFileTool,
  makeEditFileTool,
  makeDeleteFileTool,
  makeMoveFileTool,
} from "./tools/fileTools";
import { makeSearchCodeTool } from "./tools/searchCodeTool";
import {
  makeFindFileTool,
  makeFindSymbolTool,
  makeProjectOutlineTool,
  makeRelatedFilesTool,
  makeSearchCodebaseTool,
  makeSearchTestsTool,
} from "./tools/projectIntelligenceTools";
import { makeListSymbolsTool } from "./tools/symbolTools";
import { makeTerminalTool } from "./tools/terminalTool";
import {
  makeGitStatusTool,
  makeGitDiffTool,
  makeGitCommitTool,
  makeGitLogTool,
  makeGitBranchTool,
  makeGitCheckoutTool,
} from "./tools/gitTools";
import { makeGenerateImageTool } from "./tools/imageTool";
import { registerArtifactTools } from "./tools/artifactTools";
import { makeFetchUrlTool, makeWebSearchTool } from "./tools/netTools";
import { makeSshExecTool } from "./tools/sshTools";
import { makeMcpListTool, makeMcpCallTool } from "./tools/mcpTools";
import { makeSearchCapabilitiesTool } from "./tools/searchCapabilities";
import { marketplaceFor } from "../mcp/marketplace/service";
import {
  makeBrowserOpenTool,
  makeBrowserNavigateTool,
  makeBrowserClickTool,
  makeBrowserTypeTool,
  makeBrowserScreenshotTool,
  makeBrowserConsoleErrorsTool,
  makeBrowserScrollTool,
  setBrowserToolTenant,
  makeBrowserEvidenceTool,
} from "./tools/browserTools";
import { registerDesktopTools } from "./tools/desktopTools";
import { registerHostDesktopTools } from "./tools/hostDesktopTools";
import { registerComputerUseTools } from "../computerUse/computerUseTools";
import {
  makeGetDiagnosticsTool,
  makeRunTypecheckTool,
  makeRunTestsTool,
  makeRunLinterTool,
} from "./tools/diagnosticsTools";
import {
  makeStartProcessTool,
  makeStopProcessTool,
  makeReadProcessLogsTool,
  makeListProcessesTool,
} from "./tools/processTools";

// Registers the tool set into THIS TENANT's registry, bound to their project
// root. Previously this wrote into a module-global registry, which meant one
// customer's project root could be used to execute another's tool calls.
//
// Re-registering for the SAME root (e.g. the tools panel refreshing) keeps the
// user's permission overrides instead of clobbering them back to defaults.
export function registerProjectToolsFor(tenant: Tenant, projectRoot: string): void {
  const g = tenant.toolGateway;
  const sameRoot = tenant.currentProjectRoot === projectRoot;
  const saved = new Map<string, ToolPermission>();
  if (sameRoot) {
    for (const t of g.list()) saved.set(t.name, g.getPermission(t.name));
  }

  g.registry.clear();

  g.register(makeReadDocumentTool(projectRoot));
  g.register(makeCreateDocumentTool(projectRoot, tenant.artifactService));
  g.register(makeCreateZipTool(tenant.artifactService));
  registerArtifactTools((tool) => g.register(tool), tenant.artifactService);

  // Filesystem
  g.register(makeReadFileTool(projectRoot));
  g.register(makeListDirectoryTool(projectRoot));
  g.register(makeSearchFilesTool(projectRoot));
  g.register(makeSearchCodeTool(projectRoot));
  g.register(makeSearchCodebaseTool(tenant.indexService, projectRoot));
  g.register(makeFindSymbolTool(tenant.indexService, projectRoot));
  g.register(makeFindFileTool(tenant.indexService, projectRoot));
  g.register(makeRelatedFilesTool(tenant.indexService, projectRoot));
  g.register(makeSearchTestsTool(tenant.indexService, projectRoot));
  g.register(makeProjectOutlineTool(tenant.indexService, projectRoot));
  g.register(makeListSymbolsTool(projectRoot));
  tenant.indexService.bindProject(projectRoot);
  g.register(makeWriteFileTool(projectRoot));
  g.register(makeEditFileTool(projectRoot));
  g.register(makeMoveFileTool(projectRoot));
  g.register(makeDeleteFileTool(projectRoot));

  // Execution
  g.register(makeTerminalTool(projectRoot));
  g.registerAlias("run_command", "terminal");
  g.register(makeStartProcessTool(projectRoot));
  g.register(makeStopProcessTool(projectRoot));
  g.register(makeReadProcessLogsTool(projectRoot));
  g.register(makeListProcessesTool(projectRoot));

  // Verification (Testing Agent)
  g.register(makeGetDiagnosticsTool(projectRoot));
  g.register(makeRunTypecheckTool(projectRoot));
  g.register(makeRunTestsTool(projectRoot));
  g.register(makeRunLinterTool(projectRoot));

  // Network
  g.register(makeFetchUrlTool());
  g.register(makeWebSearchTool());

  // Remote administration (hosts allow-listed in .orvyn/ssh.json)
  g.register(makeSshExecTool(projectRoot));

  // Browser QA (Playwright). Registered always; each call returns a typed
  // "Playwright is not installed" error until the optional dep is added.
  setBrowserToolTenant(tenant.id);
  g.register(makeBrowserOpenTool(projectRoot));
  g.register(makeBrowserNavigateTool(projectRoot));
  g.register(makeBrowserClickTool(projectRoot));
  g.register(makeBrowserTypeTool(projectRoot));
  g.register(makeBrowserScrollTool(projectRoot));
  g.register(makeBrowserScreenshotTool(projectRoot));
  g.register(makeBrowserConsoleErrorsTool(projectRoot));
  g.register(makeBrowserEvidenceTool(projectRoot));
  registerDesktopTools((tool) => g.register(tool), projectRoot, tenant.id);
  registerHostDesktopTools((tool) => g.register(tool), tenant.id);
  registerComputerUseTools((tool) => g.register(tool), (alias, target) => g.registerAlias(alias, target), projectRoot, tenant.id, tenant.artifactService);

  // Git
  g.register(makeGitStatusTool(projectRoot));
  g.register(makeGitDiffTool(projectRoot));
  g.register(makeGitLogTool(projectRoot));
  g.register(makeGitBranchTool(projectRoot));
  g.register(makeGitCheckoutTool(projectRoot));
  g.register(makeGitCommitTool(projectRoot));

  // Media
  g.register(makeGenerateImageTool(projectRoot, tenant.modelService, tenant.artifactService));

  // MCP (servers from .orvyn/mcp.json — the hub is the only MCP speaker)
  g.register(makeMcpListTool(tenant.mcpHub, projectRoot));
  g.register(makeMcpCallTool(tenant.mcpHub, projectRoot));
  g.register(makeSearchCapabilitiesTool(() => marketplaceFor(tenant.mcpManager, tenant.localStore)));
  // registry.clear() above dropped namespaced mcp.* tools. Re-bind any
  // servers that are still CONNECTED so marketplace installs survive a run.
  tenant.mcpManager.reregisterConnectedTools();

  // Later phases append here: diagnostics/tests (Phase 5), browser (Phase 8),
  // checkpoints (Phase 9), MCP (Phase 10). Kept in one function so the gateway
  // remains the single registration path.
  for (const extend of toolRegistrars) extend(tenant, projectRoot);

  if (sameRoot) {
    for (const [name, permission] of saved) g.setPermission(name, permission);
  } else {
    // Fresh root (or first registration after a restart): re-apply the user's
    // persisted per-tool overrides for this project.
    const overrides = tenant.localStore.getToolOverrides(projectRoot);
    for (const [name, permission] of Object.entries(overrides)) {
      g.setPermission(name, permission as ToolPermission);
    }
  }
  tenant.currentProjectRoot = projectRoot;
}

type ToolRegistrar = (tenant: Tenant, projectRoot: string) => void;
const toolRegistrars: ToolRegistrar[] = [];

/** Lets later-phase modules (diagnostics, browser, MCP…) plug into the same registration pass. */
export function addToolRegistrar(fn: ToolRegistrar): void {
  toolRegistrars.push(fn);
}
