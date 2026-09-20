// apps/backend/src/agent/languageRule.ts
//
// ORVYN routes to several providers whose models are Chinese-first and will
// otherwise answer the user in Chinese — the product language is English.
// This rule is appended to EVERY model system prompt: chat, streaming agent,
// mission planner, workers, reviewer, and final summary.

export const LANGUAGE_RULE =
  "LANGUAGE: Always write your ENTIRE response in English only — every sentence, every label, every code comment. This applies regardless of the user's language, file contents, or site content you analyze. Never output Chinese or other non-English prose.";

// ---- enforcement ----------------------------------------------------------
//
// Chinese-first models mirror the user's language even when the system prompt
// forbids it, so prompts alone are not enough. These helpers DETECT Chinese
// output and force an English regeneration.

const CJK = /[\u4e00-\u9fff\u3400-\u4dbf]/g;

export function cjkRatio(text: string): number {
  if (!text) return 0;
  const letters = text.replace(/[\s\p{P}\p{S}]/gu, "");
  if (!letters) return 0;
  return ((text.match(CJK) ?? []).length) / letters.length;
}

/** True when a reply is meaningfully Chinese (not just a quoted filename). */
export function isMostlyChinese(text: string): boolean {
  const hits = (text.match(CJK) ?? []).length;
  return hits >= 4 && cjkRatio(text) > 0.2;
}

export const RETRY_RULE =
  "CRITICAL OUTPUT-LANGUAGE CORRECTION: your previous reply was mostly Chinese. Regenerate the SAME reply entirely in ENGLISH. Every word must be English. Do not output any Chinese characters.";

/** generate() with one language retry: if the model answers in Chinese, the
 *  call is repeated with an explicit correction appended; the less-Chinese
 *  of the two replies wins. Tool-calling turns only retry when the narration
 *  itself is overwhelmingly Chinese (their arguments may legitimately quote
 *  project content). */
export async function generateEnglish(
  provider: { generate(req: any): Promise<any> },
  request: any
): Promise<any> {
  const first = await provider.generate(request);
  const firstText = String(first?.content ?? "");
  const hasTools = Array.isArray(first?.toolCalls) && first.toolCalls.length > 0;
  if (!isMostlyChinese(firstText)) return first;
  if (hasTools && cjkRatio(firstText) < 0.5) return first;
  try {
    const second = await provider.generate({
      ...request,
      messages: [...(request.messages ?? []), { role: "system", content: RETRY_RULE }],
    });
    const secondText = String(second?.content ?? "");
    return cjkRatio(secondText) <= cjkRatio(firstText) ? second : first;
  } catch {
    return first;
  }
}
