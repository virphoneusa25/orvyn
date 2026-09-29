// apps/backend/src/ai/chatResearch.ts
//
// Chat that researches on its own, like the best chat assistants: the model
// is offered web_search and fetch_url and decides for itself when a question
// needs current facts. Each search and page read is reported as live
// activity ("Searched the web, read 5 pages"), and the pages it read become
// the answer's Sources.

import type { ToolDefinition } from "@orvyn/ai-core";
import { parseSearchResults } from "../gateway/toolResultEnvelope";

export interface ChatActivity {
  id: string;
  /** capability: ORION needs a tool it does not have; the chat shows an install card. */
  kind: "search" | "read" | "capability" | "handoff";
  status: "running" | "done" | "failed";
  query?: string;
  url?: string;
  title?: string;
  /** Search: how many results came back. */
  results?: number;
  /** Search: the result sites (for Sources). */
  found?: { url: string; title: string; snippet?: string }[];
  error?: string;
  /** Handoff: the self-contained instruction the task run starts with. */
  prompt?: string;
  /** Capability: why ORION needs it and the MCP servers that provide it. */
  reason?: string;
  servers?: { name?: string; server?: string; canonicalId?: string; description?: string; freeInstall?: boolean; secrets?: string[]; oauth?: boolean }[];
  /** The server ORION will install once the user approves (the card's Install button). */
  install?: { name: string; canonicalId: string; description?: string; secrets?: string[]; freeInstall?: boolean };
  /** Set by the desktop once installed. */
  installed?: boolean;
  startedAt: number;
  endedAt?: number;
}

export interface WebToolRunner {
  execute(name: string, args: Record<string, unknown>): Promise<{ ok: boolean; output?: string; error?: string; meta?: Record<string, unknown> }>;
  /** Tools of MCP servers the user installed (mcp.<server>.<tool>), offered to the chat too. */
  mcpTools?(): ToolDefinition[];
}

/** Finding a tool ORION lacks (an MCP server the user can install from the card). */
export const CHAT_CAPABILITY_TOOL: ToolDefinition = {
  name: "search_capabilities",
  description: "Find an MCP tool that gives you a capability you do not have in this chat (email, GitHub, a database, a calendar, a browser, a better web search…). ORVYN shows the user a card to install it.",
  parameters: { type: "object", properties: { query: { type: "string", description: "What you need to do, e.g. 'search the web', 'send email'" } }, required: ["query"] },
};

/** Project work from the chat: ORVYN starts a task that has the core file, shell, git and browser tools. */
export const CHAT_TASK_TOOL: ToolDefinition = {
  name: "start_project_task",
  description: "Do work in the user's project: edit, create or delete files, change the website, add an attached file, run commands, git, check the live preview. ORVYN starts a task with its core file, terminal, git and browser tools (no install needed). Write a complete instruction: resolve 'it', 'this' or '?' from the conversation.",
  parameters: { type: "object", properties: { instruction: { type: "string", description: "The full task, e.g. 'Add an animated gradient background to the hero section of index.html'" } }, required: ["instruction"] },
};

/** What the chat can do, stated as fact (so project work is never mistaken for a missing MCP tool). */
export const CHAT_MANIFEST = [
  "CAPABILITIES (facts from ORVYN): the user's project has ORVYN core tools — read/create/edit/delete files, shell, git, live preview and browser checks. They are not MCP tools and never need installing.",
  "In this chat you reach them with start_project_task. Any request to change, build, fix or check the project (including follow-ups like 'yes', 'do it', '?') → call start_project_task with a complete instruction, then tell the user in one short sentence that you're doing it.",
  "search_capabilities is ONLY for outside services with no tool here (email, Slack, a CRM, a database server, a calendar…). Never call it for project files, the website, the preview or the terminal.",
].join("\n");

/** ORVYN Cloud's web chat: a conversation with web research, files and images — not project tasks. */
export const CLOUD_CHAT_MANIFEST = [
  "CAPABILITIES (facts from ORVYN): this is ORVYN Cloud chat. You answer, research the web, read the files and images the user attaches, write and explain code, and draft documents. You do not run tasks on the user's computer or edit their project files from here.",
  "If the user wants you to change files in a project, run commands or check a site in a browser, say that ORVYN Desktop does that work and offer to plan it or write the code here.",
  "search_capabilities is ONLY for outside services with no tool here (email, Slack, a CRM, a calendar…).",
].join("\n");

export const CHAT_WEB_TOOLS: ToolDefinition[] = [
  {
    name: "web_search",
    description: "Search the web. Returns the top results (title, URL, snippet). Use it whenever the answer depends on facts you may not have or that change.",
    parameters: { type: "object", properties: { query: { type: "string", description: "What to search for" } }, required: ["query"] },
  },
  {
    name: "fetch_url",
    description: "Read a web page (http/https). Use it on the most relevant search results before answering from them.",
    parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
  },
];

export const CHAT_RESEARCH_PROMPT = [
  "You can search the web (web_search) and read pages (fetch_url) in this chat. Decide for yourself when to use them:",
  "- Research whenever the answer depends on facts you may not have or that change: prices and costs, plans and limits, versions and releases, companies, products and people, laws and policies, news, or anything you are not sure is still current. Questions about what something costs, whether it is worth it, or how it compares usually need this.",
  "- Search with specific queries, read the 2-5 most relevant pages with fetch_url, then answer from what they say. Several searches are fine when the question has several parts.",
  "- Do not search for small talk, arithmetic, writing help, or things you know reliably.",
  "- After researching, answer the question itself (with your recommendation), use the numbers you found, and end with a short Sources list of the pages you used.",
].join("\n");

/** Activity for a tool call about to run. */
export function startActivity(id: string, name: string, args: Record<string, unknown>): ChatActivity {
  return name === "web_search"
    ? { id, kind: "search", status: "running", query: String(args.query ?? ""), startedAt: Date.now() }
    : { id, kind: "read", status: "running", url: String(args.url ?? ""), startedAt: Date.now() };
}

/** The same activity once its result is in. */
export function finishActivity(a: ChatActivity, result: { ok: boolean; output?: string; error?: string }): ChatActivity {
  const out = String(result.output ?? "");
  if (!result.ok) return { ...a, status: "failed", error: String(result.error ?? "failed").slice(0, 200), endedAt: Date.now() };
  if (a.kind === "search") {
    const found = parseSearchResults(out).map((r) => ({ url: r.url, title: r.title, snippet: r.snippet.slice(0, 240) }));
    return { ...a, status: "done", results: found.length, found, endedAt: Date.now() };
  }
  const title = /<title[^>]*>([^<]{1,200})<\/title>/i.exec(out)?.[1]?.trim();
  return { ...a, status: "done", title, endedAt: Date.now() };
}

/** What the model gets back from a tool (clipped: pages can be long). */
export function toolResultForModel(result: { ok: boolean; output?: string; error?: string }): string {
  const text = result.ok ? String(result.output ?? "") : `Error: ${String(result.error ?? "failed")}`;
  return text.length > 24_000 ? `${text.slice(0, 24_000)}\n…(page truncated)` : text;
}
