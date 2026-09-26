// apps/backend/src/agent/researchIntent.ts
//
// ORION researches on its own. A task that depends on information that
// changes (latest versions, releases, prices, news, who holds a role) or that
// asks for sources gets a web search first — the user does not have to pick
// the Research mode. Purely local work (files, this project's code) does not.

const CURRENT_INFO = /\b(latest|newest|current(?:ly)?|recent(?:ly)?|today|tonight|this (?:week|month|year)|right now|up[- ]to[- ]date|as of|news|headlines?|prices?|pricing|how much (?:is|does|are)|stock|weather|forecast|scores?|standings|released?|releases|lts|announced?|announcements?|who (?:is|are|won) (?:the )?(?:current|new|ceo|president|prime minister|leader|champion)|trending|best .* (?:in|for) 20\d\d|20(?:2[5-9]|3\d))\b/i;
const ASKS_FOR_SOURCES = /\b(research|look (?:it |this |that )?up|search (?:the )?(?:web|internet|online)|google|find (?:out|sources|articles|references)|cite|citations?|with sources|sources? for|fact[- ]check|compare .+ (?:vs\.?|versus) )\b/i;
const LOCAL_ONLY = /\b(this (?:file|folder|repo|repository|project|codebase)|in (?:my|the) (?:project|repo|codebase|workspace)|hello\.txt|package\.json|\b(?!(?:node|next|nuxt|vue|react|three|d3|chart|express|nest|ember|backbone|solid)\.js\b)[\w-]+\.(?:js|ts|tsx|css|html|py|json|txt|md)\b)/i;

export function needsWebResearch(instruction: string): boolean {
  const text = String(instruction ?? "");
  if (ASKS_FOR_SOURCES.test(text)) return true;
  if (LOCAL_ONLY.test(text)) return false;
  return CURRENT_INFO.test(text);
}

/** The agent's standing instruction: decide on its own when to research. */
export const RESEARCH_HINT =
  "Research on your own when the task needs it: if it depends on facts you may not have or that change (current versions and releases, prices, news, API or library docs, real businesses, people or places, or real content and examples for something you build), call web_search first, then fetch_url the 1-3 most relevant results, and base your work on what they say. Name the sites you used. Do not search for purely local work (this project's files and code) or for things you know reliably.";

export const RESEARCH_NUDGE =
  "This depends on current information from the web. Before answering, call web_search, read the most relevant results with fetch_url, then answer from them and name the sites you used.";
