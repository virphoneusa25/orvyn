import type { ToolCall } from "@orvyn/ai-core";

const COMPLETE = /<tool_call\b[\s\S]*?<\/tool_call>/gi;
const INCOMPLETE = /<tool_call\b[\s\S]*$/i;
const ARG = /<arg_key>\s*([^<]+?)\s*<\/arg_key>\s*<arg_value>([\s\S]*?)<\/arg_value>/gi;

function cutIncomplete(text: string): string {
  const cut = text.search(INCOMPLETE);
  return (cut >= 0 ? text.slice(0, cut) : text).replace(/\n{3,}/g, "\n\n");
}

function parseArgs(block: string): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  ARG.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ARG.exec(block))) {
    const key = match[1]!.trim();
    const raw = match[2]!.trim();
    if (!key) continue;
    if ((raw.startsWith("{") && raw.endsWith("}")) || (raw.startsWith("[") && raw.endsWith("]"))) {
      try { args[key] = JSON.parse(raw); continue; } catch { /* keep string */ }
    }
    args[key] = raw;
  }
  return args;
}

function parseName(block: string): string {
  return block
    .replace(/<\/?tool_call\b[^>]*>/gi, " ")
    .replace(/<arg_key>[\s\S]*$/i, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")[0] ?? "";
}

/** Models sometimes write XML tool calls as assistant text instead of native function calls. */
export function extractLeakedToolMarkup(text: string): { text: string; calls: ToolCall[] } {
  const calls: ToolCall[] = [];
  let n = 0;
  const stripped = String(text ?? "").replace(COMPLETE, (block) => {
    const name = parseName(block);
    if (name) {
      n += 1;
      calls.push({ id: `xml_tool_${n}`, name, arguments: parseArgs(block) });
    }
    return "";
  });
  return { text: cutIncomplete(stripped), calls };
}

export function stripLeakedToolMarkup(text: string): string {
  return extractLeakedToolMarkup(text).text;
}

export function visibleAssistantDelta(shown: string, accumulatedRaw: string): { visible: string; delta: string } {
  const visible = stripLeakedToolMarkup(accumulatedRaw);
  if (visible.startsWith(shown)) return { visible, delta: visible.slice(shown.length) };
  return { visible, delta: shown ? "" : visible };
}
