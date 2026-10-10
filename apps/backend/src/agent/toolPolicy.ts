// Which tools a run may see, and which arguments are safe to execute.
// Irrelevant families stay off the model request. Empty required fields never
// reach ToolGateway.

import type { TaskIntent } from "./taskIntent";
import { isWebsiteInspection } from "./websiteInspection";

const SERVER = /^(ssh_exec|remote_exec)$/;
/** Dev servers and watchers: any task that runs commands in a project may need one. */
const SERVICE = /^(start_process|stop_process|read_process_logs|list_processes)$/;
const BROWSER = /^browser_/;
const DESKTOP = /^(desktop_|computer[._])/;
const ARTIFACT = /^(generate_image|artifact_|create_document|create_zip)$/;
/** MCP tools stay off until the task needs them; search_capabilities is always there so ORION can ask for a missing tool. */
const MCP = /^mcp[._]/i;
const GIT = /^git_/;

export function selectToolNames(
  names: string[],
  intent: TaskIntent,
  options?: { repositoryDetected?: boolean; desktopTools?: boolean }
): string[] {
  const inspection = isWebsiteInspection(intent.goal);
  const gitAllowed = options?.repositoryDetected !== false;
  return names.filter((name) => {
    if (name === "mcp_list") return true; // discovery stays available even on short follow-ups
    if (inspection && /^(write_file|edit_file|delete_file|move_file|apply_edit|apply_patch|create_file|rename_file|terminal|run_command|run_tests|run_typecheck|run_linter|start_process|stop_process|git_commit|git_checkout)$/.test(name)) return false;
    if (GIT.test(name) && !gitAllowed) return false;
    if (SERVER.test(name) && !intent.requiresRemoteResource && intent.category !== "server" && intent.category !== "deploy") {
      return false;
    }
    if (SERVICE.test(name) && !intent.requiresTerminal && !intent.requiresFrontend && intent.category !== "server" && intent.category !== "deploy") {
      return false;
    }
    if (BROWSER.test(name) && !intent.requiresBrowser && !intent.requiresFrontend && intent.category !== "browser") return false;
    // Desktop/computer-use is the product's core surface, not a guessable
    // intent: a follow-up like "try now" classified as `general` must not
    // strip the tools the conversation was just using. Every capable run
    // exposes them; read-only modes pass desktopTools:false and the mode's
    // permission profile stays authoritative either way.
    if (DESKTOP.test(name) && options?.desktopTools === false) return false;
    if (ARTIFACT.test(name) && !intent.requiresArtifact && intent.category !== "artifact") return false;
    if (MCP.test(name) && !intent.requiresExternalIntegration && intent.category !== "integration") return false;
    return true;
  });
}

// Argument validation lives at the contract layer (ai/toolArgs.ts) so the
// registry boundary can enforce it; re-exported here for existing callers.
export type { ToolParameterSchema } from "../ai/toolArgs";
export { requiredArgumentNames, validateToolArguments } from "../ai/toolArgs";

/** A website is published from the files the agent writes. A shell server is not available. */
/** Static file servers a model reaches for to "preview" a plain site. Framework dev servers (vite, next, npm run dev) are not here. */
const STATIC_SERVER = /\bpython3?\s+-m\s+(http\.server|SimpleHTTPServer)\b|\bhttp\.server\b|which python|\bnpx\s+(-y\s+)?(serve|http-server|live-server|lite-server)\b|(^|[\s;&|])(http-server|live-server|lite-server)\b|(^|[\s;&|])serve\s+(-[lp]|\.|--)|\bphp\s+-S\b|\bbusybox\s+httpd\b/i;

/** A hand-written Node server for a plain static site (ORVYN's preview already serves it). */
const NODE_STATIC_SERVER = /\bnode\s+(\S*\/)?\.orvyn\/|\bnode\s+(\S*\/)?(serve|static-?server|preview-?server|preview)\.m?js\b|\bnode\s+-e\s+.*createServer.*\.listen\(/i;

/**
 * `staticSite`: the project is a plain site (an index.html and no
 * package.json), so even a hand-written Node server only duplicates the
 * preview ORVYN already serves.
 */
export function shellServerRefusal(command: string, frontend: boolean, staticSite = false): string | null {
  if (!frontend && !staticSite) return null;
  if (!STATIC_SERVER.test(command) && !(staticSite && NODE_STATIC_SERVER.test(command))) return null;
  return "Do not start a web server for this site. ORVYN already publishes the live preview from the project files (it updates as they change) and shows it in the Preview tab; a localhost server cannot be opened by the user and dies with the process. To change the site, call write_file or edit_file on its files. To show it, tell the user it is in the Preview tab. Do not probe ports or processes.";
}

const escapeRe = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * ORVYN's own folders are not the project: the engine's data directory
 * (other workspaces, published previews, databases) and a project's
 * `.orvyn/` folder (checkpoints, internal state). Reading, searching or
 * changing them is refused; the preview is ORVYN's job, not the model's.
 */
export function internalPathRefusal(tool: string, args: Record<string, unknown>, ctx: { dataDir: string; projectRoot: string }): string | null {
  const message = "That is ORVYN's own internal storage, not part of the project. Do not read, search or change it. The live preview is published and served by ORVYN from the project files; to change the site, edit the project files. To check the site, use the browser tools on the preview URL.";
  const paths = ["path", "from", "to", "directory", "dir", "cwd"].map((k) => String(args[k] ?? "")).filter(Boolean);
  if (paths.some((p) => /(^|[\\/])\.orvyn([\\/]|$)/.test(p.replace(/^\.\//, "")))) return message;
  if (tool === "search_code" || tool === "search_files") {
    const q = String(args.pattern ?? args.query ?? "");
    if (/^\.?orvyn\b|checkpoints/.test(q) && !/\.(css|js|html?)\b/.test(q)) return message;
  }
  const command = String(args.command ?? "");
  if (command) {
    if (/(^|[\s'"/])\.orvyn\/(checkpoints|state|runs|sessions)|previews\/roots\.json/.test(command)) return message;
    const data = ctx.dataDir.replace(/[\\/]+$/, "");
    if (data && data.length > 1) {
      const root = ctx.projectRoot.replace(/[\\/]+$/, "");
      const hits = command.match(new RegExp(escapeRe(data) + "(?:[\\\\/][^\\s'\"`;|&)]*)?", "g")) ?? [];
      if (hits.some((hit) => !(root && (hit === root || hit.startsWith(root + "/") || hit.startsWith(root + "\\"))))) return message;
    }
  }
  return null;
}
