// Structured intent for one user instruction. Customer products and hostnames
// are resources, not categories — this module must stay tenant-neutral.

export type TaskCategory =
  | "general"
  | "code"
  | "server"
  | "cloud"
  | "database"
  | "deploy"
  | "browser"
  | "desktop"
  | "artifact"
  | "integration"
  | "research"
  | "automation";

export interface TaskIntent {
  category: TaskCategory;
  goal: string;
  requiresWorkspace: boolean;
  requiresRemoteResource: boolean;
  requiresTerminal: boolean;
  requiresBrowser: boolean;
  requiresDesktop: boolean;
  requiresArtifact: boolean;
  requiresExternalIntegration: boolean;
  successCriteria: string[];
  /** A conceptual question. The runtime may answer it without tools. */
  informational: boolean;
}

const INFO =
  /^(what|why|how|when|who|explain|describe|compare|tell me about|what can you|can you co-work)\b/i;

function has(text: string, re: RegExp): boolean {
  return re.test(text);
}

export function inferTaskIntent(instruction: string, composerMode?: string): TaskIntent {
  const goal = String(instruction ?? "").trim();
  const mode = String(composerMode ?? "").toLowerCase();
  const server = has(goal, /\b(server|ssh|hostname|uptime|remote host|log into|login to)\b/i) || mode === "server";
  const database = has(goal, /\b(database|postgres|mysql|sqlite|sql query|schema)\b/i);
  const deploy = has(goal, /\b(deploy|release|rollout|ship to production)\b/i) || mode === "deploy";
  const browser = has(goal, /\b(browser|homepage|webpage|open the (app|site|page))\b/i);
  const desktop = has(goal, /\b(desktop|on screen|settings dialog|computer-use)\b/i);
  const artifact = has(goal, /\b(logo|png|jpe?g|gif|webp|svg|pdf|docx|xlsx|zip|generate an image)\b/i);
  const integration = has(goal, /\b(mcp|external api|webhook|integration)\b/i);
  const cloud = has(goal, /\b(cloud account|cloud mission|worker)\b/i);
  const automation = mode === "automate" || has(goal, /\b(workflow|automate|every time)\b/i);
  const research = mode === "research" || mode === "plan";
  const code =
    mode === "code" ||
    has(goal, /\b(test|bug|fix|refactor|compile|typecheck|lint|src\/|function|file)\b/i);
  const terminal = has(goal, /\b(npm |node |pytest|terminal|run the|run tests|build)\b/i) || code || server || deploy;

  let category: TaskCategory = "general";
  if (research && !code && !server) category = "research";
  else if (artifact && !code) category = "artifact";
  else if (desktop) category = "desktop";
  else if (browser && !code) category = "browser";
  else if (database) category = "database";
  else if (server) category = "server";
  else if (deploy) category = "deploy";
  else if (integration) category = "integration";
  else if (automation) category = "automation";
  else if (cloud) category = "cloud";
  else if (code) category = "code";

  const action = has(
    goal,
    /\b(create|fix|generate|edit|update|implement|refactor|deploy|install|build|run|start|stop|write|inspect|verify|debug|modify|screenshot|login|log into|ssh)\b/i
  );
  const informational = goal.length > 0 && INFO.test(goal) && !action && category === "general";

  const success: string[] = [];
  if (server) success.push("Remote command output from the resolved server.");
  if (code && has(goal, /\b(test|verify|fix)\b/i)) success.push("The requested check ran and its result is in the tool log.");
  if (artifact) success.push("A persisted artifact id.");
  if (desktop || browser) success.push("A screenshot or verification event from this session.");
  if (has(goal, /\b(read it back|what it says|what it contains)\b/i)) success.push("A read of the file that was written.");
  if (success.length === 0 && !informational) success.push("The requested outcome is supported by a tool result.");

  return {
    category,
    goal,
    requiresWorkspace: category === "code" || category === "deploy" || has(goal, /\b(file|repo|workspace|project)\b/i),
    requiresRemoteResource:
      has(goal, /\b(ssh|log into|login to|hostname|uptime|server|remote host)\b/i) ||
      (deploy && has(goal, /\b(server|remote|ssh)\b/i)),
    requiresTerminal: terminal && !informational,
    requiresBrowser: browser,
    requiresDesktop: desktop,
    requiresArtifact: artifact,
    requiresExternalIntegration: integration,
    successCriteria: success,
    informational,
  };
}
