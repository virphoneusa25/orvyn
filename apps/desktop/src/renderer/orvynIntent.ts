// apps/desktop/src/renderer/orvynIntent.ts
//
// Pure intent classification — no DOM, no network — so the routing rules are
// unit-testable and the canonical command pipeline stays thin. Intent FIRST,
// mission creation second: nothing here talks to any backend.

export type CommandMode = "auto" | "code" | "server" | "research" | "deploy" | "automate";
export type CommandIntent = "chat" | "code" | "research" | "automate";

export type FileRequestClass = "modify-workspace" | "create-workspace" | "generate-artifact";

/** A = edit existing local file; B = new project file; C = user-facing artifact (no project required). */
export function classifyFileRequest(text: string): FileRequestClass | null {
  const t = text.trim();
  if (!t) return null;
  if (looksLikeGeneratedFileRequest(t) && !/\b(src\/|apps\/|\.orvyn\/|[A-Za-z]:\\)/.test(t)) return "generate-artifact";
  if (/\b(create|add|write|new)\b/i.test(t) && /\.(txt|md|json|html|csv|ts|tsx|js|jsx|py)\b/i.test(t)) return "create-workspace";
  if (/\b(edit|update|fix|change|modify|rewrite)\b/i.test(t) && /\b(file|folder|src|code)\b/i.test(t)) return "modify-workspace";
  if (/\b(create|add|write|new)\b/i.test(t) && /\b(file|folder|component|module)\b/i.test(t)) return "create-workspace";
  return null;
}

/** Logos, PNGs, PDFs and other deliverables do not need a local project folder. */
export function looksLikeGeneratedFileRequest(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (/\.(png|jpg|jpeg|gif|webp|svg|pdf|docx|xlsx|pptx|zip)\b/i.test(t)) return true;
  const artNoun = /\b(images?|pictures?|photos?|icons?|logos?|illustrations?|artwork|mock-?ups?|banners?|thumbnails?|pdf|docx|document|report|zip|artifact|spreadsheet)\b/i;
  const artVerb = /\b(generate|draw|render|paint|sketch|imagine|design|make|create|export|save)\b/i;
  return artVerb.test(t) && artNoun.test(t);
}

/** A text or code file named in the request ("test.txt", "notes.md", "app.js"). */
const NAMES_TEXT_FILE =
  /\b[\w.-]+\.(txt|md|markdown|json|jsonc|ya?ml|toml|ini|env|csv|tsv|log|html?|css|scss|less|js|mjs|cjs|jsx|ts|tsx|py|rb|php|go|rs|java|kt|cs|c|h|cpp|hpp|sh|bash|ps1|bat|sql|vue|svelte)\b/i;

/**
 * On ORVYN Cloud, is this request a generated deliverable (a logo, a PDF, a
 * Word document) that belongs in Cloud file storage rather than in the open
 * project folder? A request that names a text or code file is project work:
 * "Create test.txt" must land in the folder on this computer.
 */
export function belongsInCloudStorage(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  // "… in a cloud workspace" / "in ORVYN Cloud": the user chose Cloud, even
  // with a folder open. "not in the cloud" / "don't use cloud" keeps it local.
  if (/\b(?:not|don'?t|do not|never|without|no)\b[^.]{0,24}\bcloud\b/i.test(t)) return false;
  if (/\bcloud\s+workspace\b|\b(?:in|on|to|into|using)\s+(?:a|an|the|my|our)?\s*(?:orvyn\s+)?cloud\b/i.test(t)) return true;
  if (NAMES_TEXT_FILE.test(t)) return false;
  return looksLikeGeneratedFileRequest(t) || /\b(documents?|docx|pdf|spreadsheet|xlsx|slides?|pptx|report|letter|resume)\b/i.test(t);
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
  // "Can you log in to my server?" is work, not a capability question.
  if (/^(?:(?:can|could|would|will) you\s+)?(?:please\s+)?(?:create|make|write|draft|build|edit|update|fix|generate|export|convert|save|open|read|review|inspect|run|deploy|add|log\s*in|login|ssh|connect|install|test|start|stop|restart|debug|verify|launch|browse|tail|diagnose|commit|screenshot)\b/i.test(trimmed)) return mode === "research" ? "research" : "code";

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

/** Backend agent mode for an intent. Research stays read-only. Automate executes. */
export function backendModeForIntent(intent: CommandIntent): "agent" | "research" | null {
  if (intent === "chat") return null;
  if (intent === "research") return "research";
  return "agent";
}
