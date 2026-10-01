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
  requiresFrontend: boolean;
  requiresBrowserVerification: boolean;
  /** GitHub API / MCP inspect — not a local clone and not SSH. */
  requiresGitHub: boolean;
  /** Explicit resource classes this task needs. Unrelated missing resources must not block. */
  resourceRequirements: Array<
    | "workspace"
    | "repository"
    | "server"
    | "database"
    | "github_connection"
    | "browser_session"
    | "desktop_session"
    | "mcp"
  >;
  successCriteria: string[];
  /** A conceptual question. The runtime may answer it without tools. */
  informational: boolean;
  /** How heavy the execution path should be — the mission router reads this. */
  executionComplexity: ExecutionComplexity;
  /** Broad multi-domain work justifies the multi-agent runtime; simple work does not. */
  preferMultiAgent: boolean;
}

export type ExecutionComplexity = "answer" | "simple" | "standard" | "complex";

const INFO =
  /^(what|why|how|when|who|explain|describe|compare|tell me about|what can you|can you co-work)\b/i;

function has(text: string, re: RegExp): boolean {
  return re.test(text);
}

/**
 * "Can you use this logo for VirPhone?", "put the attached photo in the hero":
 * the user gave the file. That is work with their file, not a request to
 * generate a new logo/image deliverable.
 */
export function usesGivenFile(text: string): boolean {
  const t = String(text ?? "");
  return /\b(this|these|attached|my|our|the (?:attached|new|provided|uploaded))\s+(logo|image|picture|photo|icon|screenshot|graphic|banner|asset)s?\b/i.test(t)
    || /\b(use|put|add|place|swap|replace|insert|set)\b.{0,40}\b(this|attached|uploaded)\b/i.test(t);
}

export function inferTaskIntent(instruction: string, composerMode?: string): TaskIntent {
  const goal = String(instruction ?? "").trim();
  const mode = String(composerMode ?? "").toLowerCase();
  // "Start the dev server" is a local service in the project, not a remote
  // machine to log into. Only what is left after removing those counts.
  const remoteText = goal.replace(/\b(?:dev|development|local|vite|next(?:\.js)?|preview|web|http|static|node|express|api)\s+server\b/gi, "");
  const githubInspect =
    /\bgithub\b/i.test(goal) &&
    /\b(inspect|read-only|issues?|pull requests?|\bprs?\b|workflows?|repository|repo)\b/i.test(goal) &&
    !/\b(ssh|clone (it |the repo )?on my|on my (server|vps|host)|remote host)\b/i.test(goal);
  const server =
    (!githubInspect && (has(remoteText, /\b(ssh|hostname|uptime|remote host|log into|login to)\b/i) || has(remoteText, /\bserver\b/i))) ||
    mode === "server";
  const database = has(goal, /\b(database|postgres|mysql|sqlite|sql query|schema)\b/i);
  const deploy = has(goal, /\b(deploy|release|rollout|ship to production)\b/i) || mode === "deploy";
  const browser =
    // "screenshot" alone is not a browser signal — desktop screenshots exist.
    has(goal, /\b(browser|homepage|webpage|website|web app|open the (app|site|page)|viewport|mobile view)\b/i) ||
    // "Open example.com", "go to https://…": a site to look at, not a file.
    has(goal, /\b(open|visit|go to|navigate to|browse to|load)\s+(https?:\/\/\S+|(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|org|net|io|dev|app|ai|co|edu|gov|us|uk|de)\b)/i);
  const desktop = has(goal, /\b(desktop|on screen|settings dialog|computer-use)\b/i);
  // A deliverable file, not a keyword in passing: needs a produce verb AND an
  // artifact type — "Explain PDF compression" is not an artifact request.
  const artifact =
    !usesGivenFile(goal) &&
    (has(goal, /\bgenerate an image\b/i) ||
      (has(goal, /\b(create|generate|make|export|produce|build)\b/i) &&
        has(goal, /\b(logo|png|jpe?g|gif|webp|svg|pdf|docx|xlsx|zip|image|document|spreadsheet)\b/i)));
  const integration = has(goal, /\b(mcp|external api|webhook|integration)\b/i);
  const cloud = has(goal, /\b(cloud account|cloud mission|worker)\b/i);
  const automation = mode === "automate" || has(goal, /\b(workflow|automate|every time)\b/i);
  const research = mode === "research" || mode === "plan";
  const frontend = has(goal, /\b(website|web site|web app|landing page|homepage|joomla|dashboard|frontend|react|next\.?js|vue|vite|svelte|angular|astro|html|css|responsive|component|dev server|hero (?:image|animation|background|section)|(?:site|page) background)\b/i);
  // Frontend implementation verbs make a frontend task engineering work —
  // "Redesign the dashboard" is a code task even without the word "code".
  const frontendAction = has(goal, /\b(create|build|redesign|change|update|add|remove|implement|fix|modify|replace|restyle|retheme|theme|layout|design|polish|animate|make|rename|reorder|resize|improve)\b/i);
  // "My configured test server" is a server, not the word "test" implying
  // code work — that one adjective pair is neutralized for the code signal.
  const codeText = remoteText.replace(/\btest\s+server\b/gi, "server");
  const code =
    mode === "code" ||
    (frontend && frontendAction) ||
    has(codeText, /\b(test|bug|fix|refactor|compile|typecheck|lint|src\/|function|class|component|endpoint|route|module|file|code|codebase)\b/i);
  const terminal = has(goal, /\b(npm |node |pytest|terminal|run the|run tests|build|dev server|start it|keep it running|serve)\b/i) || code || server || deploy;

  const action = has(
    goal,
    /\b(create|fix|generate|edit|update|implement|refactor|deploy|install|build|run|start|stop|write|inspect|verify|debug|modify|replace|add|remove|change|restyle|connect|configure|set up|setup|delete|rename|move|make|redesign|screenshot|login|log into|ssh)\b/i
  );
  const greeting = /^(hi+|hello+|hey+|yo|sup|hiya|howdy|thanks|thank you|thx)[!.?\s]*$/i.test(goal);
  // "How do I deploy X?" is a question even though it names an action.
  const howTo = /^how\s+(do|can|should|would|to)\b/i.test(goal);
  // Informational intent is independent of the domain: "What is PostgreSQL?"
  // is a question even though it touches the database category.
  const informational = greeting || (goal.length > 0 && INFO.test(goal) && (!action || howTo));

  // The action outranks the resource: "deploy to my server" is a deploy task
  // that happens to use a server, not server administration.
  let category: TaskCategory = "general";
  if (research && !action) category = "research";
  else if (artifact && !code) category = "artifact";
  else if (automation && !code && !deploy) category = "automation";
  else if (deploy) category = "deploy";
  else if (githubInspect) category = "integration";
  else if (integration) category = "integration";
  else if (database && !code) category = "database";
  else if (server && !code) category = "server";
  else if (cloud) category = "cloud";
  else if (code) category = "code";
  else if (browser) category = "browser";
  else if (desktop) category = "desktop";

  const success: string[] = [];
  if (server) success.push("Remote command output from the resolved server.");
  if (code && has(goal, /\b(test|verify|fix)\b/i)) success.push("The requested check ran and its result is in the tool log.");
  if (frontend && !informational) {
    success.push(
      "The requested frontend change exists in the bound workspace.",
      "The project build or relevant diagnostics complete successfully.",
      "The canonical preview loads successfully.",
      "Required CSS, JavaScript, and image assets load without blocking errors.",
      "Browser verification confirms the requested UI behavior.",
      "No blocking browser console errors remain."
    );
  }
  if (deploy && !informational) {
    success.push(
      "Deployment command completed successfully.",
      "The deployed service reports healthy.",
      "The expected production endpoint responds successfully."
    );
  }
  if (database && !informational) {
    success.push(
      "The requested database operation completed against the intended database.",
      "The resulting schema or data state was read back and verified."
    );
  }
  if (integration && !informational) {
    success.push(
      "The integration is configured.",
      "A real connectivity or interoperability check succeeded."
    );
  }
  if (artifact) success.push("A persisted artifact id.");
  if ((desktop || browser) && !informational) success.push("A screenshot or verification event from this session.");
  if (has(goal, /\b(read it back|what it says|what it contains)\b/i)) success.push("A read of the file that was written.");
  if (success.length === 0 && !informational) success.push("The requested outcome is supported by a tool result.");

  const domains = [code, frontend, deploy, server, database, integration, artifact, automation].filter(Boolean).length;
  const executionComplexity: ExecutionComplexity = informational
    ? "answer"
    : domains >= 3 || (deploy && (server || code)) || (frontend && (integration || database))
      ? "complex"
      : code && domains === 1
        ? "simple"
        : "standard";

  return {
    category,
    goal,
    requiresWorkspace:
      !informational &&
      !githubInspect &&
      (category === "code" ||
        category === "deploy" ||
        frontend ||
        database ||
        has(goal, /\b(file|repo|workspace|project|codebase)\b/i)),
    requiresRemoteResource:
      !informational &&
      !githubInspect &&
      (has(remoteText, /\b(ssh|log into|login to|hostname|uptime|remote host)\b/i) ||
        (has(remoteText, /\bserver\b/i) && !/\bmcp\s+server\b/i.test(goal)) ||
        (deploy && has(goal, /\b(server|remote|ssh)\b/i))),
    requiresTerminal: terminal && !informational && !githubInspect,
    requiresBrowser: !informational && (browser || frontend),
    requiresDesktop: !informational && desktop,
    requiresArtifact: !informational && artifact,
    requiresExternalIntegration: !informational && (integration || githubInspect),
    requiresGitHub: !informational && githubInspect,
    requiresFrontend: frontend && !informational,
    requiresBrowserVerification: frontend && !informational,
    resourceRequirements: [
      ...(!informational && !githubInspect && (category === "code" || category === "deploy" || frontend || database || has(goal, /\b(file|repo|workspace|project|codebase)\b/i))
        ? (["workspace"] as const)
        : []),
      ...(!informational && githubInspect ? (["github_connection"] as const) : []),
      ...(!informational && !githubInspect && (has(remoteText, /\b(ssh|log into|login to|hostname|uptime|remote host)\b/i) || (has(remoteText, /\bserver\b/i) && !/\bmcp\s+server\b/i.test(goal)) || (deploy && has(goal, /\b(server|remote|ssh)\b/i)))
        ? (["server"] as const)
        : []),
      ...(!informational && category === "database" ? (["database"] as const) : []),
      ...(!informational && (browser || frontend) ? (["browser_session"] as const) : []),
      ...(!informational && desktop ? (["desktop_session"] as const) : []),
      ...(!informational && (integration || githubInspect) ? (["mcp"] as const) : []),
    ],
    successCriteria: success,
    informational,
    executionComplexity,
    preferMultiAgent: executionComplexity === "complex",
  };
}
