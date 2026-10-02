import { mkdirSync } from "fs";
import { join } from "path";
import { defaultDataDir } from "../persistence/LocalStore";
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
  makeApplyPatchTool,
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
import { missingVerifierCapabilities } from "../agent/VerificationRuntime";
import { githubToken } from "../integrations/githubConnection";
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
import { makeSearchCapabilitiesTool, makeInstallMcpServerTool } from "./tools/searchCapabilities";
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
  makeBrowserViewportTool,
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
  g.registerAlias("create_file", "write_file");
  g.register(makeEditFileTool(projectRoot));
  g.register(makeApplyPatchTool(projectRoot));
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
  g.register(makeSshExecTool(projectRoot, { tenantId: tenant.id, localStore: tenant.localStore }));

  // Browser QA (Playwright). Registered always; each call returns a typed
  // "Playwright is not installed" error until the optional dep is added.
  setBrowserToolTenant(tenant.id);
  g.register(makeBrowserOpenTool(projectRoot));
  g.register(makeBrowserNavigateTool(projectRoot));
  g.register(makeBrowserClickTool(projectRoot));
  g.register(makeBrowserTypeTool(projectRoot));
  g.register(makeBrowserScrollTool(projectRoot));
  g.register(makeBrowserViewportTool(projectRoot));
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
  g.register(makeSearchCapabilitiesTool(() => marketplaceFor(tenant.mcpManager, tenant.localStore, tenant.id), { githubToken: () => githubToken(tenant.id) }));
  g.register(makeInstallMcpServerTool(() => marketplaceFor(tenant.mcpManager, tenant.localStore, tenant.id), { githubToken: () => githubToken(tenant.id) }));
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
  const missing = missingVerifierCapabilities(g.list().map((tool) => tool.name));
  if (missing.length) {
    console.error(JSON.stringify({ event: "verifier.capabilities.missing", missing }));
  }
}

type ToolRegistrar = (tenant: Tenant, projectRoot: string) => void;
const toolRegistrars: ToolRegistrar[] = [];

/**
 * Tools that need no user project folder: ChatGPT-style Cloud chat — web,
 * images, documents, zips, artifacts, a scratch coding sandbox (files +
 * terminal), the Workbench Browser, and MCP discovery.
 */
export function registerWorkspaceFreeToolsFor(tenant: Tenant): void {
  const g = tenant.toolGateway;
  const have = new Set(g.list().map((t) => t.name));
  const add = (tool: { name: string }) => { if (!have.has(tool.name)) { g.register(tool as any); have.add(tool.name); } };
  const key = tenant.currentProjectRoot || join(defaultDataDir(), "scratch", tenant.id);
  mkdirSync(key, { recursive: true });
  add(makeFetchUrlTool());
  add(makeWebSearchTool());
  add(makeGenerateImageTool(undefined, tenant.modelService, tenant.artifactService));
  add(makeReadDocumentTool(key));
  add(makeCreateDocumentTool(key, tenant.artifactService));
  add(makeCreateZipTool(tenant.artifactService));
  registerArtifactTools((tool) => add(tool), tenant.artifactService);
  add(makeReadFileTool(key));
  add(makeListDirectoryTool(key));
  add(makeSearchFilesTool(key));
  add(makeSearchCodeTool(key));
  add(makeWriteFileTool(key));
  if (!have.has("create_file")) g.registerAlias("create_file", "write_file");
  add(makeEditFileTool(key));
  add(makeApplyPatchTool(key));
  add(makeMoveFileTool(key));
  add(makeDeleteFileTool(key));
  add(makeTerminalTool(key));
  if (!have.has("run_command")) g.registerAlias("run_command", "terminal");
  add(makeGetDiagnosticsTool(key));
  add(makeRunTypecheckTool(key));
  add(makeRunTestsTool(key));
  add(makeRunLinterTool(key));
  setBrowserToolTenant(tenant.id);
  for (const make of [makeBrowserOpenTool, makeBrowserNavigateTool, makeBrowserClickTool, makeBrowserTypeTool, makeBrowserScrollTool, makeBrowserViewportTool, makeBrowserScreenshotTool, makeBrowserConsoleErrorsTool, makeBrowserEvidenceTool]) add(make(key));
  registerDesktopTools((tool) => add(tool), key, tenant.id);
  registerHostDesktopTools((tool) => add(tool), tenant.id);
  add(makeMcpListTool(tenant.mcpHub, key));
  add(makeMcpCallTool(tenant.mcpHub, key));
  add(makeSearchCapabilitiesTool(() => marketplaceFor(tenant.mcpManager, tenant.localStore, tenant.id), { githubToken: () => githubToken(tenant.id) }));
  add(makeInstallMcpServerTool(() => marketplaceFor(tenant.mcpManager, tenant.localStore, tenant.id), { githubToken: () => githubToken(tenant.id) }));
  tenant.mcpManager.reregisterConnectedTools();
}

/** Lets later-phase modules (diagnostics, browser, MCP…) plug into the same registration pass. */
export function addToolRegistrar(fn: ToolRegistrar): void {
  toolRegistrars.push(fn);
}
