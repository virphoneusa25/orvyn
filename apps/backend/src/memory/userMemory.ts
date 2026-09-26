// apps/backend/src/memory/userMemory.ts
//
// ORION remembers the user across conversations: who they are, their
// companies and products, the names and decisions they settled on, their
// stack and preferences. These live in the existing memories table
// (scope "global", kind "about_user") so the Memory panel shows and edits
// them, and every chat turn and run gets them in its prompt.
//
// Learning is conservative: only what the user said about themselves or
// their work, never guesses, never secrets. "Remember that …" is saved as
// said.

import { randomUUID } from "crypto";

export const ABOUT_USER = "about_user";

export interface MemoryRow {
  id: string;
  scope: "global" | "project";
  projectRoot?: string | null;
  kind: string;
  title: string;
  content: string;
  source?: string | null;
  pinned?: boolean;
  updatedAt?: number;
}

export interface MemoryStoreLike {
  listMemories(projectRoot?: string | null, limit?: number): MemoryRow[];
  saveMemory(input: { id: string; scope: "global" | "project"; projectRoot?: string | null; kind: string; title: string; content: string; source?: string | null; pinned?: boolean }): void;
  deleteMemory(id: string): void;
}

export interface GenerateLike {
  generate(req: { messages: { role: "system" | "user" | "assistant"; content: string }[]; temperature?: number }): Promise<{ content?: string | null }>;
}

const MAX_ABOUT_USER = 40;
const SECRET = /\b(sk-[A-Za-z0-9]{8,}|ghp_[A-Za-z0-9]{8,}|AKIA[0-9A-Z]{12,}|krl_live_[A-Za-z0-9]+|-----BEGIN [A-Z ]*PRIVATE KEY-----|password\s*[:=]\s*\S+|\b\d{13,19}\b)/i;

/** The memory block for a prompt: everything about the user, plus memories relevant to this message. */
export function userMemoryPrompt(store: MemoryStoreLike | undefined, text: string, projectRoot?: string | null): string {
  if (!store) return "";
  let all: MemoryRow[] = [];
  try { all = store.listMemories(projectRoot ?? null, 300); } catch { return ""; }
  const about = all.filter((m) => m.kind === ABOUT_USER).slice(0, MAX_ABOUT_USER);
  const terms = new Set(String(text ?? "").toLowerCase().split(/[^a-z0-9_./-]+/).filter((x) => x.length > 2));
  const relevant = all
    .filter((m) => m.kind !== ABOUT_USER)
    .map((m) => ({ m, score: (m.pinned ? 5 : 0) + [...terms].reduce((n, t) => n + (`${m.title} ${m.content}`.toLowerCase().includes(t) ? 1 : 0), 0) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8)
    .map(({ m }) => `- [${m.scope}/${m.kind}] ${m.title}: ${String(m.content).slice(0, 800)}`);
  const parts: string[] = [];
  if (about.length) {
    parts.push(
      "What you know about the user (ORVYN memory; they can view and edit it in Memory). Use it naturally to tailor answers — their names for things, their companies, stack and decisions. Do not recite it or say \"according to my memory\".",
      ...about.map((m) => `- ${m.content}`),
    );
  }
  if (relevant.length) parts.push("Saved notes relevant to this request:", ...relevant);
  return parts.join("\n").slice(0, 8000);
}

const EXPLICIT = /^\s*(?:please\s+)?(?:remember|note|keep in mind|for future reference)(?:\s+that)?[:,]?\s+(.{3,})$/i;
const FIRST_PERSON = /\b(i|i'm|i am|my|we|we're|we are|our|us|me)\b/i;

/** Worth asking the model whether this message says something durable about the user. */
export function mightTeachAboutUser(text: string): boolean {
  const t = String(text ?? "").trim();
  if (EXPLICIT.test(t)) return true;
  return t.length >= 25 && FIRST_PERSON.test(t);
}

const EXTRACT_PROMPT = [
  "You maintain a short memory about ONE user of ORVYN, an AI co-worker app. From the user's message below, extract only durable facts the USER STATED about themselves or their work that will help in future conversations:",
  "who they are and their role; their companies, products, brands and projects (with the names they use); decisions they made (chosen names, architectures, vendors); their tech stack and infrastructure; lasting preferences about how they want answers.",
  "Rules: only what the user said — never guesses, never your own suggestions unless the user adopted them in this message; skip one-off task details (file names, today's bug), skip anything that expires soon; never store secrets (passwords, keys, tokens, card or account numbers) or sensitive personal data (health, religion, politics, sexuality, finances, criminal matters).",
  "Each fact is one short sentence in the third person (\"Runs VirPhone USA, a white-label VoIP platform.\"). If a fact updates an existing memory, return it under update with that id. If the user asks to forget something or corrects a memory, remove or update it.",
  "Reply with JSON only: {\"add\":[\"fact\"],\"update\":[{\"id\":\"…\",\"content\":\"fact\"}],\"remove\":[\"id\"]}. Return {\"add\":[],\"update\":[],\"remove\":[]} when there is nothing durable.",
].join("\n");

function parseJson(text: string): { add?: unknown; update?: unknown; remove?: unknown } | null {
  const m = /\{[\s\S]*\}/.exec(String(text ?? ""));
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

function titleOf(content: string): string {
  return content.replace(/\s+/g, " ").trim().slice(0, 60);
}

export interface LearnResult { added: string[]; updated: string[]; removed: string[] }

/**
 * Learns from one user message. Explicit "remember that …" is saved as said;
 * otherwise a model extracts durable facts. Never throws (memory is best-effort).
 */
export async function learnFromUserMessage(store: MemoryStoreLike | undefined, model: GenerateLike | undefined, userText: string): Promise<LearnResult> {
  const result: LearnResult = { added: [], updated: [], removed: [] };
  if (!store || !mightTeachAboutUser(userText) || SECRET.test(userText)) return result;
  let existing: MemoryRow[] = [];
  try { existing = store.listMemories(null, 300).filter((m) => m.kind === ABOUT_USER); } catch { return result; }
  const save = (content: string, id = `mem_${randomUUID()}`, source = "learned") => {
    const clean = content.replace(/\s+/g, " ").trim().slice(0, 400);
    if (!clean || SECRET.test(clean)) return false;
    if (existing.some((m) => m.content.trim().toLowerCase() === clean.toLowerCase() && m.id !== id)) return false;
    store.saveMemory({ id, scope: "global", projectRoot: null, kind: ABOUT_USER, title: titleOf(clean), content: clean, source, pinned: false });
    return true;
  };

  const explicit = EXPLICIT.exec(userText.trim());
  if (explicit && !model) {
    if (save(explicit[1]!.replace(/[.\s]+$/, "") + ".", undefined, "user")) result.added.push(explicit[1]!);
    return result;
  }
  if (!model) return result;
  try {
    const known = existing.map((m) => `${m.id}: ${m.content}`).join("\n") || "(nothing yet)";
    const reply = await model.generate({
      temperature: 0,
      messages: [
        { role: "system", content: EXTRACT_PROMPT },
        { role: "user", content: `Existing memories:\n${known}\n\nUser message:\n${String(userText).slice(0, 6000)}` },
      ],
    });
    const data = parseJson(String(reply?.content ?? ""));
    if (!data) {
      if (explicit && save(explicit[1]!, undefined, "user")) result.added.push(explicit[1]!);
      return result;
    }
    const ids = new Set(existing.map((m) => m.id));
    for (const fact of Array.isArray(data.add) ? data.add : []) {
      if (typeof fact === "string" && save(fact, undefined, explicit ? "user" : "learned")) result.added.push(fact);
    }
    for (const u of Array.isArray(data.update) ? data.update : []) {
      const row = u as { id?: unknown; content?: unknown };
      if (typeof row.id === "string" && ids.has(row.id) && typeof row.content === "string" && save(row.content, row.id, "learned")) result.updated.push(row.id);
    }
    for (const id of Array.isArray(data.remove) ? data.remove : []) {
      if (typeof id === "string" && ids.has(id)) { store.deleteMemory(id); result.removed.push(id); }
    }
  } catch {
    /* memory is best-effort; the conversation never waits on it */
  }
  return result;
}
