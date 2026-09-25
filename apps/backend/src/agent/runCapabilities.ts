// Live capability summary for a run or a chat self-description.
// Built from the tool registry and the selected model — not from a fixed denial.

export type ToolPermissionView = { name: string; permission: string };

export interface RunCapabilities {
  filesystemRead: boolean;
  filesystemWrite: boolean;
  searchCode: boolean;
  terminal: boolean;
  git: boolean;
  browser: boolean;
  desktop: boolean;
  artifacts: boolean;
  mcp: boolean;
  modelTools: boolean;
  /** True when this run's tools execute on the OVH worker. */
  cloudExecution: boolean;
  /** Human label: Local, Local Sandbox, Cloud, or unspecified. */
  executionLabel: string;
  /** False when the registry has no tools mounted. */
  mounted: boolean;
}

const READ = new Set([
  "read_file",
  "list_directory",
  "search_files",
  "search_code",
  "search_codebase",
  "find_file",
  "find_symbol",
  "read_document",
  "get_project_outline",
]);
const WRITE = new Set(["write_file", "edit_file", "delete_file", "move_file", "create_document"]);
const SEARCH = new Set(["search_files", "search_code", "search_codebase", "find_symbol", "find_file"]);
const TERMINAL = new Set([
  "terminal",
  "run_command",
  "run_tests",
  "run_typecheck",
  "run_linter",
  "start_process",
  "stop_process",
  "ssh_exec",
]);
const GIT = new Set(["git_status", "git_diff", "git_log", "git_branch", "git_checkout", "git_commit"]);
const ARTIFACTS = new Set(["generate_image", "artifact_create", "artifact_write", "create_document", "create_zip"]);
const MCP = new Set(["mcp_list", "mcp_call", "search_capabilities"]);

function usable(permission: string): boolean {
  return permission === "allowed" || permission === "ask";
}

function anyUsable(tools: ToolPermissionView[], names: Set<string>, prefix?: string): boolean {
  return tools.some((t) => usable(t.permission) && (names.has(t.name) || (prefix ? t.name.startsWith(prefix) : false)));
}

export function summarizeCapabilities(
  tools: ToolPermissionView[],
  opts: { modelTools: boolean; executionLabel?: string }
): RunCapabilities {
  return {
    filesystemRead: anyUsable(tools, READ),
    filesystemWrite: anyUsable(tools, WRITE),
    searchCode: anyUsable(tools, SEARCH),
    terminal: anyUsable(tools, TERMINAL),
    git: anyUsable(tools, GIT),
    browser: anyUsable(tools, new Set(), "browser_"),
    desktop: tools.some(
      (t) => usable(t.permission) && (t.name.startsWith("desktop_") || t.name.startsWith("computer_"))
    ),
    artifacts: anyUsable(tools, ARTIFACTS),
    mcp: anyUsable(tools, MCP) || tools.some((t) => usable(t.permission) && t.name.startsWith("mcp.")),
    modelTools: opts.modelTools,
    cloudExecution: (opts.executionLabel?.trim() || "") === "Cloud",
    executionLabel: opts.executionLabel?.trim() || "unspecified",
    mounted: tools.length > 0,
  };
}

function line(label: string, on: boolean, missing: string): string {
  return on ? `- ${label}: available` : `- ${label}: not available on this run. ${missing}`;
}

/** Prompt block injected into an engineering run after mode and access permissions apply. */
export function renderCapabilityPrompt(caps: RunCapabilities, surface: "run" | "chat" = "run"): string {
  if (surface === "chat") {
    if (!caps.mounted) {
      return [
        "No project tools are mounted on this chat connection yet.",
        "Do not invent a permanent limit, and do not claim this reply executed, edited, or verified anything.",
        "When an engineering task starts, the runtime mounts the tools that are actually registered for that run.",
      ].join("\n");
    }
    const present = [
      caps.filesystemRead ? "read files" : "",
      caps.filesystemWrite ? "edit and create files" : "",
      caps.searchCode ? "search the codebase" : "",
      caps.terminal ? "run a terminal, tests, builds, dev servers, and SSH" : "",
      caps.git ? "use git" : "",
      caps.browser ? "drive the browser" : "",
      caps.desktop ? "use the desktop session the user is looking at" : "",
      caps.artifacts ? "save generated files into Files → Generated" : "",
      caps.mcp ? "call MCP through search_capabilities and mcp_call" : "",
    ].filter(Boolean);
    return [
      "You are ORION, the engineering co-worker in this ORVYN session.",
      "This chat reply does not execute tools and must not claim that it ran, edited, tested, or verified anything.",
      `Engineering tasks on this runtime can: ${present.join("; ")}.`,
      "Answer a question about what you can do from that list.",
      "Do not deny co-working, a terminal, SSH, login, or screen inspection when that capability is in the list.",
      "Never answer 'I can't log in' or 'I can't execute commands' when terminal or SSH is listed.",
      "Do not describe the session as passive chat, and do not tell the user to apply edits themselves when the engineering runtime can do the work.",
      "Research and Plan runs stay read-only. Auto, Code, Server, Deploy, and Automate use the tools.",
    ].join("\n");
  }

  const gaps = [
    line("Read files", caps.filesystemRead, "Do not claim a file was read."),
    line("Edit and create files", caps.filesystemWrite, "Do not claim a file was edited."),
    line("Search code", caps.searchCode, "Do not claim a search ran."),
    line("Terminal, tests, builds, dev servers, and SSH", caps.terminal, "Do not claim a command ran."),
    line("Git", caps.git, "Do not claim a commit or branch change."),
    line("Browser", caps.browser, "Do not claim a page was opened or checked."),
    line("Desktop and computer-use in this session", caps.desktop, "Do not claim the screen was inspected."),
    line("Generated files and artifacts", caps.artifacts, "Do not claim a file was saved."),
    line("MCP", caps.mcp, "Do not claim an external tool was called."),
    line("Model tool calling", caps.modelTools, "Do not pretend tools were invoked."),
    line("Cloud execution", caps.cloudExecution, "Do not claim this run is executing in ORVYN Cloud."),
  ];
  return [
    `Capabilities for this run (execution: ${caps.executionLabel}):`,
    ...gaps,
    "Available includes approval-gated tools: call them. The runtime asks only when the access mode requires it.",
    "Keep working across tool results in this same run. Do not wait for a new user message between tools.",
    "Do not deny command execution, screen inspection, or co-working when the matching line says available.",
    "Do not hand an edit or a command back for someone else to apply when the tool is available.",
    "Do not claim a step happened unless a tool result in this run confirms it.",
    "A conceptual question is answered directly, without unnecessary tool calls.",
    ...(caps.terminal
      ? ["Dev servers (npm run dev, vite, next dev, a watcher) run as services: start one with start_process or terminal and it returns once it is listening, with its URL. It keeps running after this run finishes. Do not background it with & or nohup, and do not stop it at the end unless the user asks. Report the URL it printed."]
      : []),
    "Where work runs: \"Local\" is the user's own computer; \"Cloud\" is ORVYN Cloud. Call it ORVYN Cloud. Never name the hosting provider, servers, IP addresses or infrastructure behind ORVYN.",
  ].join("\n");
}

/** Extra instruction for the composer chip. Research limits apply only in research/plan runs. */
export function composerModeOverlay(composerMode: string | undefined, agentMode: string): string {
  if (agentMode === "research" || agentMode === "plan") {
    return "This run is read-only. Search and report. Do not edit files or run mutating commands. Those limits belong to this run only.";
  }
  if (agentMode === "ask" || agentMode === "debug") {
    return agentMode === "debug"
      ? "Debug: reproduce and explain the cause. Writes stay off. Terminal is only for observation."
      : "Ask: no tools. Answer from the context you were given.";
  }
  switch ((composerMode ?? "").toLowerCase()) {
    case "code":
      return "Code: search, read, edit, and use the terminal for tests, typecheck, and builds. Use git when the task needs it.";
    case "server":
      return "Server: inspect logs, processes, the shell, and ssh. You may edit files and run commands. This is not a read-only debug session.";
    case "deploy":
      return "Deploy: use the terminal, git, and service tools. Do not stop at a written plan.";
    case "automate":
      return "Automate: carry the workflow out with tools across multiple steps. Do not return only a plan.";
    case "auto":
      return "Auto: do the engineering work. Answer a conceptual question directly, without starting edits or commands.";
    default:
      return "Investigate, change, and verify with tools. Do not hand the work back.";
  }
}

const ACTION =
  /\b(create|fix|generate|edit|update|implement|refactor|deploy|install|build|run|start|stop|commit|delete|add|write|inspect|verify|debug|modify|screenshot|npm|compile|lint|tests?|log\s*in|login|ssh|connect)\b/i;

/** Engineering work that should not finish as a prose-only first reply. */
export function looksLikeActionRequest(instruction: string): boolean {
  const t = instruction.trim();
  if (t.length < 8) return false;
  if (/^(hi+|hello+|hey+|thanks|thank you|what can you|what do you|who are you|explain|why|how does|how do|tell me about)\b/i.test(t)) {
    return ACTION.test(t) && /\b(create|fix|generate|edit|run|build|deploy|inspect|implement|install|write)\b/i.test(t);
  }
  return ACTION.test(t);
}

/** Honest limits for this instruction, without refusing the rest of the task. */
export function capabilityGapNotes(instruction: string, caps: RunCapabilities): string[] {
  const notes: string[] = [];
  const wantsDesktop = /\b(screenshot|desktop|on screen|computer-use|visual verification)\b/i.test(instruction);
  const wantsBrowser = /\b(browser|webpage|open the (app|site|page))\b/i.test(instruction);
  const wantsTerminal = /\b(npm test|run (the )?tests|dev server|terminal|install|build)\b/i.test(instruction);
  if (wantsDesktop && !caps.desktop) {
    notes.push("Desktop verification is unavailable on this run. Continue with edits and tests when those tools are available, and say desktop verification was not performed.");
  }
  if (wantsBrowser && !caps.browser) {
    notes.push("Browser verification is unavailable on this run. Do not claim a page was checked.");
  }
  if (wantsTerminal && !caps.terminal) {
    notes.push("Terminal execution is unavailable on this run. Do not claim tests or a build ran.");
  }
  return notes;
}

/** Chat self-description from registered tool names. Transient run denials are ignored. */
export function chatCapabilityPrompt(toolNames: string[]): string {
  return renderCapabilityPrompt(
    summarizeCapabilities(
      toolNames.map((name) => ({ name, permission: "allowed" })),
      { modelTools: true, executionLabel: "unspecified" }
    ),
    "chat"
  );
}

export function executionLabelFor(input?: {
  executionLabel?: string;
  location?: string;
  targetActual?: string;
}): string {
  const label = input?.executionLabel?.trim();
  if (label === "Cloud" || label === "ORVYN Cloud" || label === "OVH Worker") return "Cloud";
  if (label === "Local Sandbox") return "Local Sandbox";
  if (label === "Local") return "Local";
  if (input?.targetActual === "ovh_worker" || input?.location === "OVH_WORKER") return "Cloud";
  if (input?.targetActual === "local_sandbox" || input?.location === "LOCAL_SANDBOX") return "Local Sandbox";
  if (input?.targetActual === "local_host" || input?.location === "LOCAL_HOST" || input?.location === "LOCAL") return "Local";
  return "unspecified";
}
