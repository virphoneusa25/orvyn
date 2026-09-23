// apps/desktop/src/renderer/orvynIntent.ts
//
// Pure intent classification — no DOM, no network — so the routing rules are
// unit-testable and the canonical command pipeline stays thin. Intent FIRST,
// mission creation second: nothing here talks to any backend.

export type CommandMode = "auto" | "code" | "server" | "research" | "deploy" | "automate";
export type CommandIntent = "chat" | "code" | "research" | "automate";

/** Logos, PNGs, PDFs and other deliverables do not need a local project folder. */
export function looksLikeGeneratedFileRequest(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (/\.(png|jpg|jpeg|gif|webp|svg|pdf|docx|xlsx|pptx)\b/i.test(t)) return true;
  const artNoun = /\b(images?|pictures?|photos?|icons?|logos?|illustrations?|artwork|mock-?ups?|banners?|thumbnails?|pdf|docx|document|report)\b/i;
  const artVerb = /\b(generate|draw|render|paint|sketch|imagine|design|make|create|export|save)\b/i;
  return artVerb.test(t) && artNoun.test(t);
}

const CONVERSATIONAL =
  /^(hi|hello|hey|thanks|thank you|yo|sup|good (morning|afternoon|evening)|explain|what|why|how|who|when|where|can you|could you|tell me|summar|describe)\b/i;

/**
 * Strong conversational signals — greetings and tiny-talk that must NEVER
 * become a mission, regardless of the selected mode. A user who leaves CODE
 * selected and types "hi" has not asked for engineering work.
 */
const GREETING_ONLY =
  /^(hi+|hello+|hey+|yo|sup|hiya|howdy|good (morning|afternoon|evening)|thanks|thank you|thx|ok|okay|cool|nice)[!. ]*$/i;

/** Intent-first classification for every command. */
export function classifyIntent(prompt: string, mode: CommandMode): CommandIntent {
  const trimmed = prompt.trim();

  // Absolute guard first: pure greetings/tiny-talk are chat, always.
  if (GREETING_ONLY.test(trimmed)) return "chat";

  // Polite action requests still need tools, even when phrased as a question.
  if (/^(?:(?:can|could|would|will) you\s+)?(?:please\s+)?(?:create|make|write|draft|build|edit|update|fix|generate|export|convert|save|open|read|review|inspect|run|deploy|add)\b/i.test(trimmed)) return mode === "research" ? "research" : "code";

  if (mode === "research") return "research";
  if (mode === "automate") return "automate";
  if (mode === "auto") {
    const questionish = trimmed.endsWith("?") || CONVERSATIONAL.test(trimmed);
    return questionish && trimmed.length < 220 ? "chat" : "code";
  }

  // Explicit executable modes (code/server/deploy): still rescue obviously
  // conversational messages — "how are you?" is not a deploy instruction.
  const questionish = trimmed.endsWith("?") || CONVERSATIONAL.test(trimmed);
  if (questionish && trimmed.length < 120) return "chat";

  return "code";
}
