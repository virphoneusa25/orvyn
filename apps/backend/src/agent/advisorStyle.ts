// apps/backend/src/agent/advisorStyle.ts
//
// How ORION talks when the user wants thinking, not a code change: advice,
// plans, strategy, naming, architecture, comparisons, explanations. Like a
// senior advisor: it takes a position, gives reasons tied to the user's
// situation, goes one step further, shapes the answer to its content, and
// sizes it to the question. Coding tasks keep the short status style.

const DEEP = /\b(strateg(?:y|ic|ies)|roadmap|plan(?:ning)? (?:for|to|out)|business plan|go[- ]to[- ]market|positioning|pricing (?:model|strategy)|brand(?:ing)?|naming|name (?:for|ideas|options)|names? for|what should (?:i|we) (?:call|name|build|do|use|choose)|should (?:i|we)\b|which (?:is|would be) (?:better|best)|pros and cons|trade[- ]?offs?|compare|comparison|versus|\bvs\.?\b|recommend(?:ation)?s?|advice|advise|architect(?:ure)?|system design|design (?:a|the) (?:system|platform|architecture|api)|long[- ]term|vision for|how would you|what would you|evaluate|assess|critique|review (?:my|our|this) (?:plan|idea|strategy|approach|business)|explain (?:why|how)|deep dive|in depth|thorough(?:ly)?|foundation model|train(?:ing)? (?:a|our|my) (?:model|llm))\b/i;

/** The question asks for thinking (advice, strategy, naming, architecture…), not a quick fact or a code change. */
export function isDeepQuestion(text: string, reasoningEffort?: string): boolean {
  if (reasoningEffort === "deep" || reasoningEffort === "max") return true;
  const t = String(text ?? "").trim();
  if (t.length < 12) return false;
  return DEEP.test(t);
}

export const ADVISOR_STYLE = [
  "When the user wants thinking rather than a code change (advice, a plan, strategy, naming, architecture, a comparison, an explanation), answer like a senior advisor who knows their situation:",
  "- Answer the question directly first, then go deeper. Take a position: recommend, rank (\"My top three…\"), say which option you prefer and why, and name the biggest mistake to avoid. Neutral lists of options are not an answer.",
  "- Tie every reason to the user's own situation: their companies, products, names, stack and the decisions already made in this conversation and in what you know about them. Use their names for things.",
  "- Go one step further than the literal question: anticipate the next thing they will need (for example names → how they read as API model ids → an example request → how the product uses them).",
  "- Shape the answer to its content: short paragraphs, numbered lists for options and steps, **bold** labels for key terms, fenced code blocks for anything they would copy (names, ids, commands, endpoints, config, example requests), a table for side-by-side comparisons.",
  "- Size it to the question: a quick question gets one to three sentences; strategy, planning, naming or architecture gets a thorough, structured answer. No filler, no restating the question, no customer-service openers.",
  "- End with a concrete recommendation or next step. Ask one question only when the right answer truly depends on something only the user knows.",
  "- Facts that may have changed (prices, versions, companies, releases) come from research with sources when tools allow, never from memory alone.",
].join("\n");
