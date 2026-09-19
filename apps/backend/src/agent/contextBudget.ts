// apps/backend/src/agent/contextBudget.ts
//
// Long agent runs die in one of two ways: a single enormous tool result
// (reading a 20k-line file, a verbose test run) blows the window in one step,
// or fifty modest steps accumulate past it. This module handles both — clamp
// each result on the way in, compact the history once it grows too large.
//
// The hard structural constraint throughout: OpenAI-style APIs reject a `tool`
// message that is not preceded by the `assistant` message whose `tool_calls`
// requested it. So history can never be trimmed by slicing a flat array —
// assistant turns and their tool replies move together, or not at all.

import { AIMessage } from "@orvyn/ai-core";

/** Hard ceiling on a single tool result before it is head/tail truncated. */
export const MAX_TOOL_OUTPUT_CHARS = Number(process.env.ORVYN_MAX_TOOL_OUTPUT_CHARS) || 30_000;

/**
 * Rough token estimate. Deliberately cheap and slightly pessimistic: a real
 * tokenizer would mean shipping vocab files per model, and the only decision
 * this feeds is "compact now or later", where over-estimating is the safe
 * direction. ~3.6 chars/token holds well enough for source code, which is
 * denser than prose.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 3.6);
}

export function estimateMessageTokens(m: AIMessage): number {
  let total = estimateTokens(m.content ?? "");
  if (m.reasoningContent) total += estimateTokens(m.reasoningContent);
  if (m.toolCalls) {
    for (const tc of m.toolCalls) {
      total += estimateTokens(tc.name) + estimateTokens(JSON.stringify(tc.arguments ?? {}));
    }
  }
  if (m.attachments) {
    for (const a of m.attachments) {
      // Base64 image payloads do not bill as characters; vision models price
      // them as a flat-ish tile cost, so counting the b64 length would
      // over-estimate by orders of magnitude and trigger endless compaction.
      total += a.content ? estimateTokens(a.content) : a.b64 ? 800 : 0;
    }
  }
  // Per-message wire overhead (role, delimiters, ids).
  return total + 4;
}

export function estimateConversationTokens(messages: AIMessage[]): number {
  return messages.reduce((sum, m) => sum + estimateMessageTokens(m), 0);
}

/**
 * Head+tail truncation. The middle of a long output is almost always the least
 * informative part: a stack trace's top frames and a test run's final summary
 * both survive, while the repetitive bulk between them does not.
 */
export function clampToolOutput(output: string, maxChars: number): { text: string; truncated: boolean } {
  if (output.length <= maxChars) return { text: output, truncated: false };

  const headChars = Math.floor(maxChars * 0.6);
  const tailChars = maxChars - headChars;
  const omitted = output.length - maxChars;
  const head = output.slice(0, headChars);
  const tail = output.slice(output.length - tailChars);

  return {
    text: `${head}\n\n… [${omitted.toLocaleString()} characters omitted — output truncated to fit the context window; re-read a specific range if you need the middle] …\n\n${tail}`,
    truncated: true,
  };
}

/** An assistant tool-call turn together with every tool reply it produced. */
interface TurnGroup {
  start: number;
  end: number;
  tokens: number;
}

/**
 * Groups the conversation after the preamble into assistant+tool units, so
 * compaction can move whole exchanges rather than orphaning tool messages.
 */
function groupTurns(messages: AIMessage[], from: number): TurnGroup[] {
  const groups: TurnGroup[] = [];
  let i = from;

  while (i < messages.length) {
    const start = i;
    i++;
    // Absorb the tool replies belonging to this assistant turn.
    while (i < messages.length && messages[i].role === "tool") i++;
    groups.push({
      start,
      end: i - 1,
      tokens: messages.slice(start, i).reduce((s, m) => s + estimateMessageTokens(m), 0),
    });
  }
  return groups;
}

export interface CompactionResult {
  messages: AIMessage[];
  /** True when anything was actually elided — the caller emits an event only then. */
  compacted: boolean;
  tokensBefore: number;
  tokensAfter: number;
  droppedTurns: number;
  elidedResults: number;
}

const ELIDED = "[earlier tool output elided to free context — re-run the tool if you need it again]";

/**
 * Brings a conversation back under `maxTokens`, cheapest sacrifice first.
 *
 * Order matters: tool *outputs* are ~90% of the tokens but the least valuable
 * to keep verbatim, whereas the assistant's own reasoning is what preserves
 * continuity. So stale outputs are blanked before any turn is dropped, and the
 * most recent turns are never touched — that is the agent's working memory.
 */
export function compactConversation(
  messages: AIMessage[],
  maxTokens: number,
  keepRecentTurns = 3
): CompactionResult {
  const tokensBefore = estimateConversationTokens(messages);
  if (tokensBefore <= maxTokens) {
    return { messages, compacted: false, tokensBefore, tokensAfter: tokensBefore, droppedTurns: 0, elidedResults: 0 };
  }

  // The preamble is load-bearing: the system prompt defines the rules and the
  // first user message is the actual task. Losing either derails the run.
  const preambleEnd = messages.length > 1 && messages[1].role === "user" ? 2 : 1;
  const preamble = messages.slice(0, preambleEnd);
  const working = messages.slice(preambleEnd).map((m) => ({ ...m }));

  let elidedResults = 0;
  let droppedTurns = 0;

  const groups = groupTurns(working, 0);
  const protectedFrom = Math.max(0, groups.length - keepRecentTurns);

  // Phase 1 — blank stale tool outputs, oldest first.
  for (let g = 0; g < protectedFrom; g++) {
    if (estimateConversationTokens([...preamble, ...working]) <= maxTokens) break;
    const group = groups[g];
    for (let i = group.start; i <= group.end; i++) {
      const m = working[i];
      if (m.role === "tool" && m.content !== ELIDED && m.content.length > ELIDED.length) {
        m.content = ELIDED;
        elidedResults++;
      }
    }
  }

  // Phase 2 — still too big, so drop whole exchanges from the oldest end.
  if (estimateConversationTokens([...preamble, ...working]) > maxTokens) {
    const survivingGroups = groupTurns(working, 0);
    const keepFrom = Math.max(0, survivingGroups.length - keepRecentTurns);
    let dropUntil = 0;

    for (let g = 0; g < keepFrom; g++) {
      dropUntil = survivingGroups[g].end + 1;
      const remaining = [...preamble, ...working.slice(dropUntil)];
      droppedTurns = g + 1;
      if (estimateConversationTokens(remaining) <= maxTokens) break;
    }

    if (dropUntil > 0) {
      working.splice(0, dropUntil);
      // Leave a marker so the model knows its history is partial rather than
      // concluding it never did the work.
      working.unshift({
        role: "assistant",
        content: `[${droppedTurns} earlier tool exchange(s) were removed from this conversation to stay within the context window. Their results are no longer visible; re-run a tool if you need that information again.]`,
      });
    }
  }

  const compactedMessages = [...preamble, ...working];
  return {
    messages: compactedMessages,
    compacted: elidedResults > 0 || droppedTurns > 0,
    tokensBefore,
    tokensAfter: estimateConversationTokens(compactedMessages),
    droppedTurns,
    elidedResults,
  };
}
