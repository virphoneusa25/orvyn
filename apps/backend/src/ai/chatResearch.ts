// apps/backend/src/ai/chatResearch.ts
//
// Chat that researches on its own, like the best chat assistants: the model
// is offered web_search and fetch_url and decides for itself when a question
// needs current facts. Each search and page read is reported as live
// activity ("Searched the web, read 5 pages"), and the pages it read become
// the answer's Sources.

import type { ToolDefinition } from "@orvyn/ai-core";
import { parseSearchResults } from "../gateway/toolResultEnvelope";
import { normalizePublicHttpUrl } from "./tools/netTools";

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
  install?: { name: string; canonicalId: string; description?: string; secrets?: string[]; freeInstall?: boolean; connect?: string; secretsProvided?: string[] };
  /** Set by the desktop once installed. */
  installed?: boolean;
  startedAt: number;
  endedAt?: number;
}

export interface WebToolRunner {
  execute(name: string, args: Record<string, unknown>): Promise<{ ok: boolean; output?: string; error?: string; meta?: Record<string, unknown>; artifacts?: { artifactId: string; name: string; mimeType: string }[] }>;
  /** Tools of MCP servers the user installed (mcp.<server>.<tool>), offered to the chat too. */
  mcpTools?(): ToolDefinition[];
}

/** Finding a tool ORION lacks (an MCP server the user can install from the card). */
export const CHAT_CAPABILITY_TOOL: ToolDefinition = {
  name: "search_capabilities",
  description: "Find an MCP tool for an outside service this chat does not have (email, Slack, a CRM, a calendar, GitHub). Do not use this for images, documents, zip files, web search, or running code — those are core ORVYN tools.",
  parameters: { type: "object", properties: { query: { type: "string", description: "What you need to do, e.g. 'send email'" } }, required: ["query"] },
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

/** ORVYN Cloud's web chat: ChatGPT-style conversation with research, files, images, and a code sandbox. */
export const CLOUD_CHAT_MANIFEST = [
  "CAPABILITIES (facts from ORVYN): this is ORVYN Cloud chat. You answer, research the web (web_search, fetch_url), read attached files and images, generate images with generate_image, write downloadable PDF/DOCX/XLSX/PPTX/CSV with create_document, pack files with create_zip, write and run code in this chat's sandbox (list_directory, read_file, write_file, edit_file, apply_patch, search_files, terminal), and save extra downloadable files with artifact_create.",
  "Call those tools. Do not say you cannot generate images, create files, or run code. Do not search MCP for them.",
  "If the user wants work on a folder on their own computer, say ORVYN Desktop binds that folder. You can still write and run the code here and give them downloadable files.",
  "search_capabilities is ONLY for outside services with no tool here (email, Slack, a CRM, a calendar…). Image generation is generate_image, documents are create_document, code is write_file + terminal — never MCP.",
].join("\n");

export const CHAT_WEB_TOOLS: ToolDefinition[] = [
  {
    name: "web_search",
    description: "Search the web. Returns the top results (title, URL, snippet). Use it whenever the answer depends on facts you may not have or that change.",
    parameters: { type: "object", properties: { query: { type: "string", description: "What to search for" } }, required: ["query"] },
  },
  {
    name: "fetch_url",
    description: "Read a web page. Pass a full https URL or bare domain. After 401/403 for a host, do not retry that host or use r.jina.ai — use web_search snippets instead.",
    parameters: { type: "object", properties: { url: { type: "string", description: "https://… or example.com" } }, required: ["url"] },
  },
];

/** ChatGPT-style Cloud tools: images, documents, archives, and a coding sandbox. */
export const CLOUD_CHAT_TOOLS: ToolDefinition[] = [
  {
    name: "generate_image",
    description: "Generate an image from a detailed prompt. The file is saved and shown as a Preview/Download card.",
    parameters: { type: "object", properties: { prompt: { type: "string", description: "Subject, style, lighting, composition" }, filename: { type: "string" } }, required: ["prompt"] },
  },
  {
    name: "create_document",
    description: "Create a downloadable PDF, DOCX, XLSX, PPTX, CSV, Markdown or text file.",
    parameters: { type: "object", properties: { name: { type: "string" }, title: { type: "string" }, content: { type: "string" }, rows: { type: "array" }, slides: { type: "array" } }, required: ["name"] },
  },
  {
    name: "create_zip",
    description: "Zip in-memory files into a downloadable archive (HTML sites, code, exports).",
    parameters: { type: "object", properties: { name: { type: "string" }, files: { type: "array", items: { type: "object", properties: { name: { type: "string" }, content: { type: "string" } } } } }, required: ["name", "files"] },
  },
  {
    name: "artifact_create",
    description: "Save a downloadable text file (HTML, JSON, CSV, source code) into Files → Generated.",
    parameters: { type: "object", properties: { name: { type: "string" }, content: { type: "string" } }, required: ["name", "content"] },
  },
  {
    name: "list_directory",
    description: "List files in this chat's code sandbox.",
    parameters: { type: "object", properties: { path: { type: "string" } } },
  },
  {
    name: "read_file",
    description: "Read a file in this chat's code sandbox.",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  },
  {
    name: "write_file",
    description: "Create or overwrite a file in this chat's code sandbox.",
    parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] },
  },
  {
    name: "edit_file",
    description: "Replace exact text in a sandbox file (search-and-replace).",
    parameters: { type: "object", properties: { path: { type: "string" }, old_string: { type: "string" }, new_string: { type: "string" }, replace_all: { type: "boolean" } }, required: ["path", "old_string", "new_string"] },
  },
  {
    name: "apply_patch",
    description: "Replace a sandbox file with new contents.",
    parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path"] },
  },
  {
    name: "search_files",
    description: "Find files in the sandbox by filename substring.",
    parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  },
  {
    name: "terminal",
    description: "Run a shell command in the sandbox (python, node, tests, scripts).",
    parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
  },
  {
    name: "read_document",
    description: "Extract text from a DOCX, PDF, XLSX, PPTX, CSV or Markdown file in the sandbox.",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  },
];

export const CLOUD_CHAT_TOOL_NAMES = new Set(CLOUD_CHAT_TOOLS.map((t) => t.name));

export const CHAT_RESEARCH_PROMPT = [
  "You can search the web (web_search) and read pages (fetch_url) in this chat. Decide for yourself when to use them:",
  "- Research whenever the answer depends on facts you may not have or that change: prices and costs, plans and limits, versions and releases, companies, products and people, laws and policies, news, or anything you are not sure is still current. Questions about what something costs, whether it is worth it, or how it compares usually need this.",
  "- Search with specific queries, then fetch_url at most one URL per host. If a read returns 401, 403, or a block, stop fetching that host (every path). Do not use r.jina.ai or any fetch proxy. Switch to web_search snippets or browser_open, then give one concise answer about what you could and could not verify.",
  "- Do not search for small talk, arithmetic, writing help, or things you know reliably.",
  "- After researching, answer the question itself (with your recommendation), use the numbers you found, and end with a short Sources list of the pages you used.",
].join("\n");

/** Activity for a tool call about to run. */
export function startActivity(id: string, name: string, args: Record<string, unknown>): ChatActivity {
  if (name === "web_search") {
    return { id, kind: "search", status: "running", query: String(args.query ?? ""), startedAt: Date.now() };
  }
  if (name === "fetch_url") {
    const n = normalizePublicHttpUrl(args.url);
    return { id, kind: "read", status: "running", url: n.ok ? n.url.toString() : String(args.url ?? ""), startedAt: Date.now() };
  }
  return { id, kind: "search", status: "running", query: `${name} ${String(args.prompt ?? args.path ?? args.command ?? args.name ?? "").slice(0, 120)}`.trim(), startedAt: Date.now() };
}

/** The same activity once its result is in. */
export function finishActivity(a: ChatActivity, result: { ok: boolean; output?: string; error?: string }): ChatActivity {
  const out = String(result.output ?? "");
  if (!result.ok) {
    const raw = String(result.error ?? "failed");
    const host = a.url ? a.url.replace(/^https?:\/\//, "").split("/")[0]!.replace(/^www\./, "") : "the page";
    const safe = /401/.test(raw)
      ? `Could not read ${host} — the server required a login (401).`
      : /403|forbidden|blocked|BOT_BLOCKED|WAF/i.test(raw)
        ? `Could not read ${host} — the site blocked automated access.`
        : `Could not read ${host}.`;
    return { ...a, status: "failed", error: safe, endedAt: Date.now() };
  }
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

export function artifactsFromChatResult(result: { artifacts?: { artifactId?: string; name?: string; mimeType?: string }[]; output?: string }): { artifactId: string; name: string; mimeType: string }[] {
  const fromField = (result.artifacts ?? []).filter((a) => a?.artifactId).map((a) => ({
    artifactId: String(a.artifactId),
    name: String(a.name ?? "file"),
    mimeType: String(a.mimeType ?? ""),
  }));
  if (fromField.length) return fromField;
  try {
    const parsed = JSON.parse(String(result.output ?? ""));
    const rows = Array.isArray(parsed?.artifacts) ? parsed.artifacts : parsed?.artifactId ? [parsed] : [];
    return rows.filter((a: any) => a?.artifactId).map((a: any) => ({
      artifactId: String(a.artifactId),
      name: String(a.name ?? a.filename ?? "file"),
      mimeType: String(a.mimeType ?? ""),
    }));
  } catch {
    return [];
  }
}
