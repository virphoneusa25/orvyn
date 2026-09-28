import { CONVERSATION_STYLE } from "../agent/conversationStyle";
import { classifyModelFailure, isModelNotFound, isRouteBlocked, markModelUnavailable, markProviderFailure, markProviderSuccess, type FailureClass } from "../models/modelAvailability";
import { sameModelElsewhere } from "../models/modelEquivalents";
import { builtInToolsFor } from "../agent/capabilityGap";
import { needsExternalTool } from "../agent/capabilityGap";
import { CAPABILITY_NUDGE, CAPABILITY_RULE, capabilityForToolName, capabilityGapFor, claimsToolUnavailable, emptySearchResult, unwrapParallelCalls } from "../agent/capabilityGap";
import { CHAT_CAPABILITY_TOOL, CHAT_MANIFEST, CHAT_TASK_TOOL, CHAT_RESEARCH_PROMPT, CHAT_WEB_TOOLS, finishActivity, startActivity, toolResultForModel, type ChatActivity, type WebToolRunner } from "./chatResearch";
import { needsWebResearch, RESEARCH_NUDGE } from "../agent/researchIntent";
const MAX_RESEARCH_ROUNDS = 6;
const MAX_RESEARCH_CALLS = 12;
import { userMemoryPrompt, type MemoryStoreLike } from "../memory/userMemory";
import { ADVISOR_STYLE, isDeepQuestion } from "../agent/advisorStyle";
import { startRoute } from "../models/routingPolicy";
import { generateEnglish, isMostlyChinese, RETRY_RULE } from "../agent/languageRule";
// apps/backend/src/ai/Orchestrator.ts
import { AIMessage, AIChunk, Attachment, TaskType, type ToolCall, type AIModelProvider } from "@orvyn/ai-core";
import { ModelService } from "../services/ModelService";
import { IndexService } from "../indexing/IndexService";
import { ImageService } from "../images/ImageService";
import { looksLikeImageRequest, stripImagePrefix } from "./imageIntent";

export type ChatMode = "ask" | "plan" | "debug" | "agent";

export interface ChatAttachment {
  path: string;
  kind: "text" | "image";
  purpose?: "reference" | "review" | "edit";
  content?: string;
  mime?: string;
  dataUrl?: string;
}

export interface ChatContext {
  currentFile?: { path: string; content: string };
  mentionedFiles?: { path: string; content: string }[];
  attachments?: ChatAttachment[];
  selectedCode?: string;
  projectRules?: string;
  useRag?: boolean;
  projectRoot?: string;
  mode?: ChatMode;
}

export interface ChatTurnRequest {
  task: TaskType;
  history: AIMessage[];
  userMessage: string;
  context?: ChatContext;
  attachments?: Attachment[];
  /** "auto" or a concrete configured model id selected for this chat turn. */
  requestedModelId?: string;
  /** Composer reasoning effort; honored only by models that declare support. */
  reasoningEffort?: "auto" | "fast" | "standard" | "deep" | "max";
  /** Server-built summary of registered tools. Never taken from the client as truth. */
  capabilityPrompt?: string;
}

function modeInstructions(mode: ChatMode | undefined): string {
  switch (mode) {
    case "plan":
      return [
        "MODE: Plan. Produce an implementation plan from the attached context.",
        "Output: goal, approach, ordered steps, files to touch, risks, and what to verify.",
        "This chat turn does not edit the disk. Do not claim it did.",
      ].join(" ");
    case "debug":
      return [
        "MODE: Debug. Pinpoint the root cause before describing a fix.",
        "Use attached files, logs, screenshots, and the current file as evidence.",
        "Structure: what we know, likely cause, how to confirm, then the smallest fix.",
        "This chat turn does not apply the fix. Do not claim it did.",
      ].join(" ");
    case "agent":
      return [
        "MODE: Agent. Describe the change in concrete files and why.",
        "This chat turn does not execute tools. An engineering run does the edit, the command, and the verification.",
      ].join(" ");
    default:
      return [
        "MODE: Ask. Answer the question from the capability summary and any attached context.",
        "This chat turn does not execute tools. Do not claim files changed or commands ran.",
        "Image generation is a separate path. When the user asks for a logo, icon, or picture, produce the image. Do not send them to another design tool.",
      ].join(" ");
  }
}

// Base64 data URLs must never travel to a text model as message content —
// one generated image is megabytes of base64 (≈ hundreds of thousands of
// tokens) and instantly blows the context window on the next turn.
const DATA_URL_RE = /data:[a-zA-Z0-9.+/-]+;base64,[A-Za-z0-9+/=]{256,}/g;

function sanitizeForModel(text: string): string {
  return text.replace(DATA_URL_RE, "[inline image omitted — saved to disk]");
}

// Budgets are in characters (~4 chars/token): history gets ~30k tokens,
// a single message ~6k, the open file ~15k. Newest history wins.
const HISTORY_CHAR_BUDGET = 120_000;
const MESSAGE_CHAR_CAP = 24_000;
const CURRENT_FILE_CHAR_CAP = 60_000;

function boundedHistory(history: AIMessage[]): AIMessage[] {
  const out: AIMessage[] = [];
  let used = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    let content = sanitizeForModel(String(m.content ?? ""));
    if (content.length > MESSAGE_CHAR_CAP) {
      content = content.slice(0, MESSAGE_CHAR_CAP) + "\n…[message truncated]";
    }
    if (used + content.length > HISTORY_CHAR_BUDGET) break;
    used += content.length;
    out.unshift({ ...m, content });
  }
  return out;
}

async function buildMessages(req: ChatTurnRequest, indexService?: IndexService, memory?: MemoryStoreLike): Promise<AIMessage[]> {
  const messages: AIMessage[] = [];
  const mode = req.context?.mode ?? "ask";

  const systemParts: string[] = [
    CONVERSATION_STYLE,
    req.capabilityPrompt?.trim() ||
      "You are ORION, the engineering co-worker in this ORVYN session. In chat you can research the web; other tools run in tasks.",
    "Voice: a sharp teammate. Use contractions. Be specific. Lead with the useful answer.",
    "Never use: \"How can I assist you today?\", \"Certainly!\", \"Of course!\", \"Great question!\", \"I'd be happy to help\", or any other customer-service opener.",
    "A short hi gets a short hello. A question about what you can do is answered from the capability summary, without starting work and without denying tools that summary lists.",
    "When a file, image, or folder is attached, use it. Ask for a folder only when the answer actually depends on those files.",
    "Put code in fenced markdown blocks with a language tag.",
    ADVISOR_STYLE,
    "In chat, this advisor style replaces the short final-reply rule: size each answer to the question.",
    "Image generation is built in. When the user asks to mock up, draw, design, or generate a logo, icon, or picture, produce the image.",
    modeInstructions(mode),
  ];
  if (req.context?.projectRules) {
    systemParts.push(`Project rules (.orvyn/rules.md):\n${req.context.projectRules}`);
  }
  const remembered = userMemoryPrompt(memory, req.userMessage, req.context?.projectRoot ?? null);
  if (remembered) systemParts.push(remembered);
  messages.push({ role: "system", content: systemParts.join("\n\n") });

  if (req.context?.currentFile) {
    const raw = req.context.currentFile.content ?? "";
    const clipped =
      raw.length > CURRENT_FILE_CHAR_CAP
        ? raw.slice(0, CURRENT_FILE_CHAR_CAP) + `\n…[file truncated at ${CURRENT_FILE_CHAR_CAP} chars of ${raw.length}]`
        : raw;
    messages.push({
      role: "system",
      content: `Current file: ${req.context.currentFile.path}\n\n${clipped}`,
    });
  }

  const textAttachments = (req.context?.attachments ?? []).filter((a) => a.kind === "text" && a.content);
  const mentioned = [...(req.context?.mentionedFiles ?? [])];
  for (const a of textAttachments) {
    if (!mentioned.some((m) => m.path === a.path)) mentioned.push({ path: a.path, content: a.content ?? "" });
  }
  if (mentioned.length) {
    const blocks = mentioned
      .slice(0, 10)
      .map((f) => {
        const att = textAttachments.find((a) => a.path === f.path);
        const purpose = att?.purpose ? ` [${att.purpose}]` : "";
        return `--- ${f.path}${purpose} ---\n${f.content.slice(0, 8000)}`;
      })
      .join("\n\n");
    messages.push({
      role: "system",
      content: `Attached files for this turn. Treat "review" as code to critique, "edit" as files the user wants changed, "reference" as context only:\n\n${blocks}`,
    });
  }
  if (req.context?.selectedCode) {
    messages.push({ role: "system", content: `Selected code:\n${req.context.selectedCode}` });
  }

  if (req.context?.useRag && indexService) {
    const hits = await indexService.search(req.userMessage, 5);
    if (hits.length > 0) {
      const formatted = hits
        .map((h) => `--- ${h.path} (lines ${h.startLine}-${h.endLine}, relevance ${h.score.toFixed(2)}) ---\n${h.snippet}`)
        .join("\n\n");
      messages.push({ role: "system", content: `Relevant code from repository index:\n\n${formatted}` });
    }
  }

  messages.push(...boundedHistory(req.history ?? []));
  const fromBar = req.attachments ?? [];
  const fromContext = (req.context?.attachments ?? []).map((a) => {
    if (a.kind === "image") {
      const b64 = a.dataUrl?.includes(",") ? a.dataUrl.split(",")[1] : a.dataUrl;
      return { kind: "image" as const, name: a.path, b64, mediaType: a.mime };
    }
    return { kind: "file" as const, name: a.path, content: a.content };
  });
  const merged: Attachment[] = [...fromBar, ...fromContext];
  const images = (req.context?.attachments ?? [])
    .filter((a) => a.kind === "image" && a.dataUrl)
    .slice(0, 4)
    .map((a) => ({ url: a.dataUrl as string }));
  const imageNote = merged.some((a) => a.kind === "image") || images.length
    ? `\n\n(${Math.max(merged.filter((a) => a.kind === "image").length, images.length)} image(s) attached — look at them.)`
    : "";
  messages.push({
    role: "user",
    content: req.userMessage + imageNote,
    ...(merged.length ? { attachments: merged } : {}),
    ...(images.length ? { images } : {}),
  });
  return messages;
}

/** Tools every task run has (the chat itself has only web tools). */
/**
 * The instruction a handed-off task starts with: the model's own instruction,
 * or — when it is vague ("this task") or the user only said "?"/"yes" — the
 * user's last real request from the conversation.
 */
export function handoffPrompt(instruction: string, req: Pick<ChatTurnRequest, "userMessage" | "history">): string {
  const substantive = (t: string) => t.replace(/[^\p{L}\p{N}]+/gu, " ").trim().split(/\s+/).filter(Boolean).length >= 4 && !/^(yes|yeah|ok|okay|sure|do it|go ahead|please|continue)\b/i.test(t.trim());
  if (instruction && substantive(instruction) && !/^(this|the) task$/i.test(instruction.trim())) return instruction;
  if (substantive(req.userMessage)) return req.userMessage;
  const history = [...(req.history ?? [])].reverse();
  for (const m of history) {
    const text = typeof m.content === "string" ? m.content : Array.isArray(m.content) ? (m.content as any[]).map((p) => p?.text ?? "").join(" ") : "";
    if (m.role === "user" && substantive(text)) return text;
  }
  return instruction || req.userMessage;
}

const TASK_TOOLS = new Set(["read_file", "edit_file", "write_file", "list_directory", "search_code", "terminal", "run_command", "run_tests", "browser_open", "browser_screenshot"]);

/** "Use this logo" with an image attached: the user's image, not a new one. */
function usesGivenImage(req: ChatTurnRequest): boolean {
  const images = [...(req.attachments ?? []), ...((req.context as { attachments?: { kind?: string }[] } | undefined)?.attachments ?? [])].some((a) => a?.kind === "image");
  return images && /\b(this|these|attached|my|our|the (attached|new|provided|uploaded))\s+(logo|image|picture|photo|icon|design|graphic|banner)s?\b|\b(use|put|add|place|swap|replace|insert)\b/i.test(req.userMessage);
}

export class Orchestrator {
  constructor(
    private modelService: ModelService,
    private indexService?: IndexService,
    private artifacts?: import("../artifacts/ArtifactService").ArtifactService,
    /** What ORION remembers about the user, shown in every chat turn. */
    private memory?: MemoryStoreLike,
    /** web_search / fetch_url: the chat researches on its own when present. */
    private webTools?: WebToolRunner
  ) {}

  private resolveProvider(req: ChatTurnRequest) {
    const requested = req.requestedModelId?.trim();
    if (requested && requested !== "auto") {
      const provider = this.modelService.registry.get(requested);
      if (!provider) throw new Error(`Requested model "${requested}" is not configured.`);
      const capability = req.task === "chat" ? "chat" : req.task;
      if (!(provider.config.capabilities as any)[capability]) throw new Error(`Requested model "${requested}" cannot handle "${req.task}".`);
      return provider;
    }
    const hasImages =
      (req.attachments ?? []).some((a) => a.kind === "image") ||
      (req.context?.attachments ?? []).some((a) => a.kind === "image");
    if (hasImages) {
      try {
        const vision = this.modelService.router.resolve("vision");
        if (vision.supportsVision()) return vision;
      } catch {
        // Fall through to the requested task.
      }
    }
    // Thinking-heavy questions (strategy, planning, naming, architecture, or
    // the user asked for deep reasoning) go to the strongest reasoning model.
    // Routing policy: a strong reasoning model first (Gemini 3.8 Flash), Claude
    // Sonnet 5 behind it; GPT-5.6 Sol only when ultra escalation is allowed.
    if (req.task === "chat" && isDeepQuestion(req.userMessage, req.reasoningEffort)) {
      const route = startRoute({ profile: "deep", instruction: req.userMessage, availableIds: this.modelService.registry.list().map((p) => p.config.id) });
      const deep = route.registryId ? this.modelService.registry.get(route.registryId) : undefined;
      if (deep && (deep.config.capabilities as any).chat !== false) return deep;
    }
    const routed = this.modelService.router.resolve(req.task);
    if (!isRouteBlocked(routed.config.id)) return routed;
    // The routed model is missing, or its provider is cooling down: the same model elsewhere, else another chat model.
    return this.chatAlternative(routed) ?? routed;
  }

  /** Same model on another provider first, then the Auto ladder, then any chat model with tools. */
  private chatAlternative(current: AIModelProvider): AIModelProvider | undefined {
    const registry = this.modelService.registry;
    const ok = (p: AIModelProvider | undefined): p is AIModelProvider =>
      Boolean(p && p.config.id !== current.config.id && p.config.id !== "orvyn-mock" && (p.config.capabilities as any).chat !== false && p.supportsTools() && !isRouteBlocked(p.config.id));
    for (const id of sameModelElsewhere(current.config.id, (x) => Boolean(registry.get(x)))) {
      const p = registry.get(id);
      if (ok(p)) return p;
    }
    const route = startRoute({ profile: "auto", instruction: "", availableIds: registry.list().map((p) => p.config.id).filter((id) => id !== current.config.id) });
    const routed = route.registryId ? registry.get(route.registryId) : undefined;
    if (ok(routed)) return routed;
    return registry.list().find((p) => ok(p));
  }

  /** A chat model call failed before anything was shown: mark it and pick where to retry. */
  private chatFailover(current: AIModelProvider, kind: FailureClass, err: unknown): AIModelProvider | undefined {
    const reason = String((err as Error)?.message ?? err);
    if (kind === "model") markModelUnavailable(current.config.id, reason);
    else markProviderFailure(current.config.id, kind, reason);
    const next = this.chatAlternative(current);
    console.warn(JSON.stringify({ event: "model.failover", surface: "chat", modelId: current.config.id, fallback: next?.config.id ?? null, failure: kind, reason: reason.slice(0, 200) }));
    return next;
  }

  async *streamChat(req: ChatTurnRequest): AsyncIterable<AIChunk & { activity?: ChatActivity; retract?: boolean }> {
    if (looksLikeImageRequest(req.userMessage) && !usesGivenImage(req)) {
      yield* this.streamGeneratedImage(req);
      return;
    }
    let provider = this.resolveProvider(req);
    const messages = await buildMessages(req, this.indexService, this.memory);
    const temperature = req.context?.mode === "ask" ? 0.7 : 0.3;
    // The chat researches on its own when it has web tools and a model that can call them.
    const installedTools = (this.webTools?.mcpTools?.() ?? []).slice(0, 24);
    const web = this.webTools && provider.supportsTools() ? [...CHAT_WEB_TOOLS, CHAT_TASK_TOOL, CHAT_CAPABILITY_TOOL, ...installedTools] : undefined;
    const isInstalledTool = (n: string) => installedTools.some((t) => t.name === n);
    if (web) messages.splice(1, 0, { role: "system", content: `${CHAT_RESEARCH_PROMPT}\n${CAPABILITY_RULE}\n${CHAT_MANIFEST}` });
    let toolCallsUsed = 0;
    let nudged = false;
    let capabilityNudged = false;
    const requested = new Map<string, string>();
    // A missing capability: find an MCP server, show the install card (as chat activity), tell the model.
    const requestCapability = async function* (this: Orchestrator, query: string): AsyncGenerator<AIChunk & { activity?: ChatActivity }, string> {
      const seen = requested.get(query);
      if (seen) return seen;
      let servers: NonNullable<ChatActivity["servers"]> = [];
      // A tool the user already installed can do it: use that instead of asking again.
      const ready = installedTools.filter((t) => /search/i.test(query) ? /search/i.test(t.name) : true);
      if (ready.length && /search/i.test(query)) {
        const note = `Use ${ready.map((t) => t.name).join(", ")} (installed MCP tools) to ${query}.`;
        requested.set(query, note);
        return note;
      }
      // Work ORVYN's core tools do (edit the site, add the attached logo, run
      // a command) — anything that names no outside service — is never a
      // Marketplace card: hand it to a real task run now.
      if (!needsExternalTool(query) || builtInToolsFor(query, (n) => TASK_TOOLS.has(n)).length) {
        const handoff: ChatActivity = { id: `handoff_${Date.now()}`, kind: "handoff", status: "done", query, prompt: handoffPrompt(query, req), startedAt: Date.now(), endedAt: Date.now() };
        yield { delta: "", activity: handoff, done: false };
        const note = `ORVYN is starting this as a task in the user's project right now, where ORION has file, terminal and browser tools. Do not ask for a tool or say one is missing. Tell the user in one short sentence that you are doing it now — then stop.`;
        requested.set(query, note);
        return note;
      }
      let reason = "";
      try {
        const found = await this.webTools!.execute("search_capabilities", { query });
        const required = found.ok ? (found.meta?.capabilityRequired as { reason?: string; recommendedServers?: typeof servers } | undefined) : undefined;
        servers = required?.recommendedServers ?? [];
        reason = required?.reason ?? "";
      } catch { servers = []; }
      const pick = servers.find((c) => c.canonicalId && !c.oauth);
      const primary = pick?.name || pick?.server || servers[0]?.name || servers[0]?.server;
      const activity: ChatActivity = {
        id: `cap_${requested.size + 1}_${Date.now()}`,
        kind: "capability",
        status: "done",
        query,
        reason: reason || (primary ? `ORION needs ${primary} to ${query}.` : "No tool for this is installed yet. Pick one in Tools & MCP → Marketplace and ORION will finish the task."),
        servers,
        ...(pick ? { install: { name: String(primary), canonicalId: pick.canonicalId!, description: pick.description, secrets: pick.secrets ?? [], freeInstall: pick.freeInstall } } : {}),
        startedAt: Date.now(),
        endedAt: Date.now(),
      };
      yield { delta: "", activity, done: false };
      const note = pick
        ? `ORVYN is asking the user to approve installing ${primary} (an MCP server) so you can ${query}; when they approve, ORVYN installs it and you continue. Do not say the tool is unavailable. Tell the user in one sentence that you need ${primary} to ${query} and that approving the install below lets you continue — then stop.`
        : primary
        ? `ORVYN is showing the user an install card for ${primary} (an MCP server) so you can ${query}. Do not say the tool is unavailable. If another tool you have can do it, use it; otherwise tell the user in one or two sentences that you need ${primary} to ${query}, why, and that installing it from the card lets you finish.`
        : `ORVYN is showing the user a card to add an MCP tool that can ${query}. Do not say the tool is unavailable. If another tool you have can do it, use it; otherwise tell the user in one or two sentences what you need and that adding it from Tools & MCP lets you finish.`;
      requested.set(query, note);
      return note;
    };
    try {
      for (let round = 0; round < MAX_RESEARCH_ROUNDS + 1; round++) {
        const offerTools = web && round < MAX_RESEARCH_ROUNDS && toolCallsUsed < MAX_RESEARCH_CALLS ? web : undefined;
        let text = "";
        const calls: ToolCall[] = [];
        let buffered = "";
        let decided = round > 0;
        // A provider failure before anything was shown retries this round on
        // the same model elsewhere (or an equivalent); nothing is repeated.
        let received = false;
        for (let attempt = 0; ; attempt++) {
        try {
        for await (const chunk of provider.stream({ messages, stream: true, temperature, reasoningEffort: req.reasoningEffort, tools: offerTools })) {
          if (chunk.toolCall || chunk.delta) received = true;
          if (chunk.toolCall) { calls.push(chunk.toolCall); continue; }
          if (chunk.done) break;
          if (!chunk.delta) continue;
          text += chunk.delta;
          // Output-language guard (first words only): Chinese-first models can
          // mirror the user's language; regenerate in English before showing it.
          if (!decided) {
            buffered += chunk.delta;
            if (buffered.trim().length < 8) continue;
            decided = true;
            if (isMostlyChinese(buffered)) {
              const retry = await generateEnglish(provider, { messages: [...messages, { role: "system", content: RETRY_RULE }], temperature });
              const english = String(retry?.content ?? "");
              for (const piece of english.match(/[\s\S]{1,24}/g) ?? []) {
                yield { delta: piece, done: false };
                await new Promise<void>((resolve) => setImmediate(resolve));
              }
              yield { delta: "", done: true };
              return;
            }
            yield { delta: buffered, done: false };
            continue;
          }
          yield { delta: chunk.delta, done: false };
        }
        markProviderSuccess(provider.config.id);
        break;
        } catch (err) {
          const kind = classifyModelFailure(err);
          const next = !received && kind && attempt < 3 ? this.chatFailover(provider, kind, err) : undefined;
          if (!next) throw err;
          provider = next;
          buffered = "";
        }
        }
        if (!decided && buffered) yield { delta: buffered, done: false };

        if (!calls.length) {
          // Answered from memory a question that needs current facts: research first (once).
          if (web && !nudged && toolCallsUsed === 0 && needsWebResearch(req.userMessage)) {
            nudged = true;
            if (text) yield { delta: "", retract: true, done: false };
            messages.push({ role: "assistant", content: text });
            messages.push({ role: "user", content: RESEARCH_NUDGE });
            continue;
          }
          // "Search isn't available": ask for the tool instead (once).
          if (web && !capabilityNudged && round < MAX_RESEARCH_ROUNDS && claimsToolUnavailable(text)) {
            capabilityNudged = true;
            if (text) yield { delta: "", retract: true, done: false };
            messages.push({ role: "assistant", content: text });
            messages.push({ role: "user", content: CAPABILITY_NUDGE });
            continue;
          }
          yield { delta: "", done: true };
          return;
        }
        const known = (n: string) => n === "web_search" || n === "fetch_url" || n === "search_capabilities" || n === "start_project_task" || isInstalledTool(n);
        const turnCalls = unwrapParallelCalls(calls, known);
        messages.push({ role: "assistant", content: text, toolCalls: turnCalls });
        for (const call of turnCalls) {
          toolCallsUsed++;
          if (call.name === "start_project_task") {
            const instruction = String((call.arguments as { instruction?: string })?.instruction ?? "").trim();
            if (!requested.has("task")) {
              const handoff: ChatActivity = { id: `handoff_${Date.now()}`, kind: "handoff", status: "done", query: instruction || req.userMessage, prompt: handoffPrompt(instruction, req), startedAt: Date.now(), endedAt: Date.now() };
              yield { delta: "", activity: handoff, done: false };
              requested.set("task", "started");
            }
            messages.push({ role: "tool", toolCallId: call.id, name: call.name, content: "ORVYN started this as a task in the user's project (core file, terminal, git and browser tools). Tell the user in one short sentence that you're doing it now — then stop." });
            continue;
          }
          if (call.name === "search_capabilities") {
            const query = String((call.arguments as { query?: string })?.query ?? "").trim() || "this task";
            const note = yield* requestCapability.call(this, query);
            messages.push({ role: "tool", toolCallId: call.id, name: call.name, content: note });
            continue;
          }
          if (isInstalledTool(call.name)) {
            let activity = startActivity(call.id || `call_${toolCallsUsed}`, /search/i.test(call.name) ? "web_search" : "fetch_url", { query: (call.arguments as any)?.query ?? (call.arguments as any)?.q ?? call.name, url: (call.arguments as any)?.url ?? call.name });
            yield { delta: "", activity, done: false };
            const result: { ok: boolean; output?: string; error?: string } = await this.webTools!.execute(call.name, call.arguments ?? {}).catch((err: any) => ({ ok: false, error: String(err?.message ?? err) }));
            activity = finishActivity(activity, result);
            yield { delta: "", activity, done: false };
            messages.push({ role: "tool", toolCallId: call.id, name: call.name, content: toolResultForModel(result) });
            continue;
          }
          const allowed = call.name === "web_search" || call.name === "fetch_url";
          if (!allowed) {
            const note = yield* requestCapability.call(this, capabilityForToolName(call.name));
            messages.push({ role: "tool", toolCallId: call.id, name: call.name, content: `There is no tool named "${call.name}" in this chat.\n\n${note}` });
            continue;
          }
          let activity = startActivity(call.id || `call_${toolCallsUsed}`, call.name, call.arguments ?? {});
          yield { delta: "", activity, done: false };
          const result: { ok: boolean; output?: string; error?: string } = await this.webTools!.execute(call.name, call.arguments ?? {}).catch((err: any) => ({ ok: false, error: String(err?.message ?? err) }));
          activity = finishActivity(activity, result);
          yield { delta: "", activity, done: false };
          let content = toolResultForModel(result);
          const gap = result.ok ? (emptySearchResult(call.name, String(result.output ?? "")) ? "search the web" : null) : capabilityGapFor({ toolName: call.name, error: String(result.error ?? "") });
          if (gap) content = `${content}\n\n${yield* requestCapability.call(this, gap)}`;
          messages.push({ role: "tool", toolCallId: call.id, name: call.name, content });
        }
        if (text.trim()) yield { delta: "\n\n", done: false };
      }
      yield { delta: "", done: true };
    } catch (err: any) {
      // The model does not exist for this account: skip it and answer with another one.
      if (isModelNotFound(err) && !(req as any).__modelFallback) {
        markModelUnavailable(provider.config.id, String(err?.message ?? err));
        yield* this.streamChat({ ...req, requestedModelId: undefined, __modelFallback: true } as ChatTurnRequest);
        return;
      }
      yield { delta: `\n\n[Error: ${err.message}]`, done: true };
    }
  }

  async chat(req: ChatTurnRequest) {
    if (looksLikeImageRequest(req.userMessage) && !usesGivenImage(req)) {
      let content = "";
      for await (const chunk of this.streamGeneratedImage(req)) {
        if (chunk.delta) content += chunk.delta;
      }
      return { content, finishReason: "stop" as const };
    }
    const provider = this.resolveProvider(req);
    const messages = await buildMessages(req, this.indexService, this.memory);
    return provider.generate({ messages, temperature: req.context?.mode === "ask" ? 0.7 : 0.3 });
  }

  private async *streamGeneratedImage(req: ChatTurnRequest): AsyncIterable<AIChunk> {
    yield { delta: "Generating image…\n\n", done: false };
    try {
      if (!this.artifacts) throw new Error("Artifact storage is not configured. Image generation cannot succeed without persistence.");
      const prompt = stripImagePrefix(req.userMessage) || req.userMessage;
      const result = await new ImageService(this.modelService, this.artifacts).generate({
        prompt,
        projectRoot: req.context?.projectRoot,
        size: "1024x1024",
      });
      const blocks = result.images
        .map((img) => {
          const cap = img.filename;
          const src = img.previewUrl ? `${img.previewUrl}` : "";
          return src
            ? `Persisted \`${cap}\` (artifact ${img.artifactId}). Preview and download from the card or Files → Generated.`
            : `Persisted \`${cap}\` as artifact ${img.artifactId}.`;
        })
        .join("\n\n");
      yield { delta: `Generated with ${result.model}:\n\n${blocks}`, done: true };
    } catch (err: any) {
      yield {
        delta:
          `Image generation failed: ${err.message}\n\n` +
          "Add or enable an image model in AI Models (the image task), then try again. I can generate logos and mockups once that model is configured.",
        done: true,
      };
    }
  }
}
