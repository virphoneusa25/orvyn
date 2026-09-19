// apps/backend/src/ai/Orchestrator.ts
import { AIMessage, AIChunk, Attachment, TaskType } from "@orvyn/ai-core";
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
}

function modeInstructions(mode: ChatMode | undefined): string {
  switch (mode) {
    case "plan":
      return [
        "MODE: Plan. Produce an implementation plan, not a dump of finished code.",
        "Output: goal, approach, ordered steps, files to touch, risks, and what to verify.",
        "Do not write large patches unless the user asks. Do not claim you edited the disk.",
      ].join(" ");
    case "debug":
      return [
        "MODE: Debug. Pinpoint the root cause before proposing a fix.",
        "Use attached files, logs, screenshots, and the current file as evidence.",
        "Structure: what we know, likely cause, how to confirm, then the smallest fix.",
        "Do not shotgun-rewrite files. Ask for a missing log or repro if you need it.",
      ].join(" ");
    case "agent":
      return [
        "MODE: Agent. You may propose concrete file edits the user can apply.",
        "Prefer working patches. Say which files change and why.",
      ].join(" ");
    default:
      return [
        "MODE: Ask. Answer questions, review code, and explain.",
        "Do not apply edits or invent that you changed files. If a change is needed, describe it and let the user apply it.",
        "You CAN generate images (logos, icons, mockups, pictures). Never say you cannot create images or tell the user to use Canva. If they ask for artwork, just generate it.",
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

async function buildMessages(req: ChatTurnRequest, indexService?: IndexService): Promise<AIMessage[]> {
  const messages: AIMessage[] = [];
  const mode = req.context?.mode ?? "ask";

  const systemParts: string[] = [
    "You are ORVYN, a coding assistant living in a desktop IDE — same job as Cursor's chat: think with the user, write and edit code, debug, and ship.",
    "Voice: a sharp teammate, not a helpdesk. Use contractions. Be specific. Lead with the useful answer.",
    "Never use: \"How can I assist you today?\", \"Certainly!\", \"Of course!\", \"Great question!\", \"I'd be happy to help\", or any other customer-service opener.",
    "Match the user's energy. A short hi gets a short human hello (one line) and maybe \"What are we building?\" — not a mission statement.",
    "When you have a file, image, or folder in context, use it. If you don't, still help; only ask for a folder when you actually need the files.",
    "Put code in fenced markdown blocks with a language tag. Prefer working snippets over lectures.",
    "Image generation is built in. When the user asks to mock up, draw, design, or generate a logo, icon, or picture, produce the image — do not refuse and do not suggest Canva or Illustrator.",
    modeInstructions(mode),
  ];
  if (req.context?.projectRules) {
    systemParts.push(`Project rules (.orvyn/rules.md):\n${req.context.projectRules}`);
  }
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

export class Orchestrator {
  constructor(private modelService: ModelService, private indexService?: IndexService) {}

  private resolveProvider(req: ChatTurnRequest) {
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
    return this.modelService.router.resolve(req.task);
  }

  async *streamChat(req: ChatTurnRequest): AsyncIterable<AIChunk> {
    if (looksLikeImageRequest(req.userMessage)) {
      yield* this.streamGeneratedImage(req);
      return;
    }
    const provider = this.resolveProvider(req);
    const messages = await buildMessages(req, this.indexService);
    try {
      yield* provider.stream({ messages, stream: true, temperature: req.context?.mode === "ask" ? 0.7 : 0.3 });
    } catch (err: any) {
      yield { delta: `\n\n[Error: ${err.message}]`, done: true };
    }
  }

  async chat(req: ChatTurnRequest) {
    if (looksLikeImageRequest(req.userMessage)) {
      let content = "";
      for await (const chunk of this.streamGeneratedImage(req)) {
        if (chunk.delta) content += chunk.delta;
      }
      return { content, finishReason: "stop" as const };
    }
    const provider = this.resolveProvider(req);
    const messages = await buildMessages(req, this.indexService);
    return provider.generate({ messages, temperature: req.context?.mode === "ask" ? 0.7 : 0.3 });
  }

  private async *streamGeneratedImage(req: ChatTurnRequest): AsyncIterable<AIChunk> {
    yield { delta: "Generating image…\n\n", done: false };
    try {
      const prompt = stripImagePrefix(req.userMessage) || req.userMessage;
      const result = await new ImageService(this.modelService).generate({
        prompt,
        projectRoot: req.context?.projectRoot,
        size: "1024x1024",
      });
      const blocks = result.images
        .map((img) => {
          const src = img.dataUrl || img.url;
          const cap = img.relativePath || img.url || "image";
          return src ? `![${cap}](${src})\n\nSaved as \`${cap}\`` : `Saved as \`${cap}\``;
        })
        .join("\n\n");
      yield { delta: `Here's a generated mockup (${result.model}):\n\n${blocks}`, done: true };
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
