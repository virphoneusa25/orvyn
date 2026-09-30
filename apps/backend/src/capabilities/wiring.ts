// apps/backend/src/capabilities/wiring.ts
//
// §17 wiring: maps gateway tool names to canonical capability ids, seeds
// the registry from the running tool set, and funnels execution results
// into the rolling reliability/health model. The model-facing manifest
// stays a plain tool list; the registry is the selection/explainability
// layer ABOVE it.

import type { Capability, CapabilitySource } from "./registry";
import { CapabilityRegistry } from "./registry";

export const capabilityRegistry = new CapabilityRegistry();

/** Gateway tool name → canonical capability id + source. */
const TOOL_MAP: Record<string, { id: string; source: CapabilitySource }> = {
  read_file: { id: "file.read", source: "core" },
  write_file: { id: "file.write", source: "core" },
  edit_file: { id: "file.patch", source: "core" },
  search_code: { id: "file.search", source: "core" },
  search_files: { id: "file.search", source: "core" },
  search_codebase: { id: "semantic.search", source: "core" },
  find_symbol: { id: "symbol.search", source: "core" },
  list_directory: { id: "workspace.list", source: "core" },
  git_status: { id: "git.status", source: "core" },
  git_diff: { id: "git.diff", source: "core" },
  git_log: { id: "git.show", source: "core" },
  terminal: { id: "shell.run", source: "core" },
  run_command: { id: "shell.run", source: "core" },
  browser_open: { id: "browser.open", source: "core" },
  browser_navigate: { id: "browser.open", source: "core" },
  browser_console_errors: { id: "browser.console", source: "core" },
  browser_screenshot: { id: "browser.screenshot", source: "core" },
  fetch_url: { id: "web.fetch", source: "core" },
  web_search: { id: "web.search", source: "core" },
  generate_image: { id: "image.generate", source: "core" },
  artifact_create: { id: "artifact.write", source: "core" },
};

/** Seed (or refresh) the registry from the gateway's registered tool names. */
export function seedCapabilities(toolNames: string[]): void {
  for (const name of toolNames) {
    const mapped = TOOL_MAP[name] ?? { id: name, source: "core" as CapabilitySource };
    if (capabilityRegistry.get(mapped.id)) continue;
    capabilityRegistry.register({
      id: mapped.id,
      name,
      source: mapped.source,
      description: "",
      taskTypes: [],
      permissions: [],
      health: "available",
      reliability: 1,
      latencyClass: "fast",
      costClass: "free",
      dispatchTool: name,
    });
  }
}

/** The canonical capability a gateway tool name belongs to (or undefined). */
export function capabilityForTool(tool: string): Capability | undefined {
  const mapped = TOOL_MAP[tool];
  return mapped ? capabilityRegistry.get(mapped.id) : undefined;
}

/** Feed one execution result into the registry's rolling reliability. */
export function reportToolResult(tool: string, ok: boolean): void {
  const cap = capabilityForTool(tool);
  if (cap) capabilityRegistry.reportResult(cap.id, ok, ok ? undefined : "degraded");
}
