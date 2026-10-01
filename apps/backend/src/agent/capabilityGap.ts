// apps/backend/src/agent/capabilityGap.ts
//
// ORION never tells the user "that tool isn't available" or "I couldn't do it
// because of a tool". When it lacks a capability, ORVYN finds an MCP server
// that provides it and asks the user to install it (the install card), and
// ORION says in one sentence what it needs and why.
//
//   - A tool the model invented (no such tool) → capability search for it.
//   - A tool that failed because something is missing (no search provider,
//     not configured, no API key, blocked) → capability search.
//   - OpenAI's `multi_tool_use.parallel` wrapper (some models emit it) is
//     unwrapped into the real calls instead of failing.
//   - A final answer that still claims a tool is unavailable is sent back once.

import type { ToolCall } from "@orvyn/ai-core";

export const CAPABILITY_RULE = [
  "MISSING TOOLS: Never tell the user a tool is unavailable, missing, not working, or that you could not do something because of a tool.",
  "If you need an OUTSIDE service you have no tool for (email, GitHub, a database server, a calendar, a CRM…), call search_capabilities with what you need.",
  "web_search and fetch_url are native when listed in this run. Use them before looking for an MCP search server.",
  "Reading, writing, creating or deleting project files, shell commands, git and the live preview are ORVYN core tools — never search for or ask to install a tool for them.",
  "When it finds an MCP server to install, ORVYN shows the user an install card. Tell the user in one or two sentences what you need, why, and that installing it from the card lets you finish; then stop and wait.",
  "Use a tool you already have first when one can do the job (for example fetch_url on a known site when web_search fails).",
].join("\n");

export const CAPABILITY_NUDGE =
  "Do not tell the user a tool is unavailable or that you could not do it because of a tool. Call search_capabilities with the capability you need. If ORVYN finds a server to install, tell the user in one or two sentences what you need, why, and that installing it from the card lets you finish. Otherwise do the task with the tools you have.";

/** Tool-name pseudo wrappers some models emit for parallel calls. */
const PARALLEL_WRAPPER = /^(multi_tool_use\.parallel|multi_tool_use|parallel|functions\.parallel|multi_search|parallel_search)$/i;

/**
 * Expands `multi_tool_use.parallel` ({tool_uses:[{recipient_name:"functions.web_search", parameters:{…}}]})
 * and multi-query search wrappers into real calls. Other calls pass through.
 */
export function unwrapParallelCalls(calls: ToolCall[], known: (name: string) => boolean): ToolCall[] {
  const out: ToolCall[] = [];
  for (const call of calls) {
    if (!PARALLEL_WRAPPER.test(call.name) || known(call.name)) {
      out.push(call);
      continue;
    }
    const args = (call.arguments ?? {}) as Record<string, unknown>;
    const uses = Array.isArray(args.tool_uses) ? args.tool_uses : Array.isArray(args.calls) ? args.calls : null;
    if (uses) {
      uses.forEach((u: any, i: number) => {
        const name = String(u?.recipient_name ?? u?.name ?? u?.tool ?? "").replace(/^functions\./, "");
        if (!name) return;
        out.push({ id: `${call.id}_${i}`, name, arguments: (u?.parameters ?? u?.arguments ?? u?.args ?? {}) as Record<string, unknown> });
      });
      continue;
    }
    const queries = Array.isArray(args.queries) ? args.queries : null;
    if (queries && known("web_search")) {
      queries.slice(0, 6).forEach((q: unknown, i: number) => out.push({ id: `${call.id}_${i}`, name: "web_search", arguments: { query: String(q) } }));
      continue;
    }
    out.push(call);
  }
  return out;
}

const SEARCH_NAME = /(^|[._])(search|web|google|bing|brave|duckduckgo|serp|tavily|exa|browse|lookup)([._]|$)/i;

/** What ORION needs, as a phrase ("search the web"), from a tool name the model wanted. */
export function capabilityForToolName(name: string): string {
  const n = String(name ?? "").replace(/^functions\./, "");
  if (/mail|gmail|smtp|inbox/i.test(n)) return "send and read email";
  if (/github|pull_request|issue/i.test(n)) return "work with GitHub";
  if (/postgres|mysql|sql|database|db_/i.test(n)) return "query the database";
  if (/calendar|meeting/i.test(n)) return "use your calendar";
  if (/slack|discord|teams|chat_post/i.test(n)) return "post to team chat";
  if (/image|dalle|draw/i.test(n)) return "generate images";
  if (SEARCH_NAME.test(n) || /search/i.test(n)) return "search the web";
  if (/browser|navigate|screenshot|page/i.test(n)) return "control a browser";
  return `use ${n.replace(/^mcp\./, "").replace(/[._-]+/g, " ").trim() || "this capability"}`;
}

/** A web tool failed in a way that means the capability is missing or blocked (not a bad query). */
const WEB_GAP = /\b(HTTP (4\d\d|5\d\d)|Search failed|Fetch failed|no results parsed|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|fetch failed|timed? ?out|aborted|captcha|blocked|rate limit|anomaly)\b/i;
const MISSING = /\b(not configured|no api key|api key (is )?(missing|required|not set)|missing api key|not installed|not connected|no provider|no search provider|unavailable|not available|not enabled|requires? (an? )?(api key|token|credentials|connection))\b/i;

/**
 * The capability to ask the user to install, when a tool call failed because
 * something is missing. Null for ordinary failures (bad path, failing test…).
 */
export function capabilityGapFor(input: { toolName: string; error: string; unknownTool?: boolean }): string | null {
  const name = String(input.toolName ?? "");
  const error = String(input.error ?? "");
  if (input.unknownTool || /^Unknown tool\b/i.test(error)) return capabilityForToolName(name);
  // A core tool (files, shell, git) that failed is a workspace, worker or
  // permission problem — never a missing Marketplace tool.
  if (/^(read_file|write_file|edit_file|apply_edit|delete_file|move_file|rename_file|list_directory|list_files|search_code|search_files|terminal|run_command|run_tests|run_typecheck|run_linter|start_process|stop_process|git_[a-z]+)$/.test(name)) return null;
  if (name === "web_search" && (WEB_GAP.test(error) || MISSING.test(error))) return "search the web";
  if (name === "fetch_url" && MISSING.test(error)) return "browse the web";
  if (/^(browser_|computer[._]|desktop_)/.test(name) && MISSING.test(error)) return "control a browser";
  if (/^mcp\./.test(name) && MISSING.test(error)) return capabilityForToolName(name);
  if (MISSING.test(error) && !/\b(file|path|directory|ENOENT)\b/i.test(error)) return capabilityForToolName(name);
  return null;
}

/** A web_search "success" that returned nothing usable (the keyless fallback got blocked). */
export function emptySearchResult(toolName: string, output: string): boolean {
  return toolName === "web_search" && /^\(no results( parsed)?/i.test(String(output ?? "").trim());
}

/** A reply that blames a tool instead of asking for one. */
const CLAIMS = [
  /\b(tool|search|web search|browsing|browser|internet access|web access)\b[^.\n]{0,60}\b(isn'?t|is not|aren'?t|are not|wasn'?t|was not)\s+(available|accessible|enabled|supported|working|configured)/i,
  /\b(don'?t|do not|didn'?t|did not)\s+have\s+(access to\s+)?(a |any |the )?(tool|web search|search tool|browsing|internet|web access|a way)\b/i,
  /\b(unable|not able|couldn'?t|could not|can'?t|cannot)\s+(to\s+)?(search|browse|access the (web|internet)|use (the |a )?(tool|search)|resolve (the )?(search )?tool|run (the )?(search|tool))/i,
  /\bno (web search|search tool|browsing tool|tool) (is )?(available|configured)/i,
  /\b(search|tool)[^.\n]{0,40}\b(couldn'?t|could not|failed to) (be )?resolve/i,
];

export function claimsToolUnavailable(text: string): boolean {
  const t = String(text ?? "");
  return CLAIMS.some((re) => re.test(t));
}

/**
 * The run's own tools that already cover a capability ORION asked for
 * ("edit the VirPhone website" → edit_file, write_file). Empty when the
 * capability is something new (email, GitHub, a database, web search).
 */
/**
 * Only work that reaches an outside service needs a new (MCP) tool. Anything
 * else — "this task", "the hero", "add an animation", "fix it" — is work in
 * the user's project, which ORION's own file/terminal/browser tools do.
 */
const EXTERNAL = /\b(e-?mails?|gmail|outlook|inbox|sms|text messages?|slack|discord|teams|telegram|whatsapp|github|gitlab|bitbucket|jira|linear|asana|trello|notion|confluence|google|drive|sheets|docs|calendar|database|postgres(?:ql)?|mysql|mongo(?:db)?|redis|sqlite|supabase|firebase|stripe|paypal|payments?|twilio|aws|azure|gcp|s3|cloudflare|vercel|netlify|figma|salesforce|hubspot|crm|zendesk|shopify|api|webhooks?|weather|maps?|search the web|web search|search online|the internet|browse the web|news|youtube|twitter|x\.com|linkedin|facebook|instagram|dropbox|box|sharepoint|onedrive|zapier)\b/;
export function needsExternalTool(query: string): boolean {
  return EXTERNAL.test(String(query ?? "").toLowerCase());
}

export function builtInToolsFor(query: string, known: (name: string) => boolean): string[] {
  const q = String(query ?? "").toLowerCase();
  if (/\b(search the web|web search|search online|browse the web|look up online)\b/.test(q)) {
    return ["web_search", "fetch_url"].filter(known);
  }
  if (/\b(email|gmail|github|slack|calendar|database|postgres|mysql|jira|notion|stripe|twilio|google)\b/.test(q)) return [];
  const groups: [RegExp, string[]][] = [
    [/\b(edit|write|create|update|change|modify|fix|add|remove|build|make)\b.*\b(file|site|website|web ?page|page|html|css|javascript|js|code|project|app|component|style|hero|section|logo|header|footer)\b|\b(website|web ?site|landing page|html|css)\b/, ["read_file", "edit_file", "write_file"]],
    [/\b(run|execute|terminal|shell|command|npm|build|install packages?|tests?)\b/, ["terminal", "run_command", "run_tests"]],
    [/\b(preview|screenshot|open the (?:page|site)|check the (?:page|site)|browser|render)\b/, ["browser_open", "browser_screenshot"]],
    [/\b(read|look at|inspect|list|find)\b.*\b(files?|folders?|project|code)\b/, ["read_file", "list_directory", "search_code"]],
  ];
  const out = new Set<string>();
  for (const [re, tools] of groups) if (re.test(q)) for (const t of tools) if (known(t)) out.add(t);
  // Nothing outside the project named: it is project work, whatever the wording.
  if (!out.size && !needsExternalTool(q)) for (const t of ["read_file", "edit_file", "write_file", "terminal", "browser_open"]) if (known(t)) out.add(t);
  return [...out];
}
