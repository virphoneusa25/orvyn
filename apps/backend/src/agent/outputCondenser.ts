// apps/backend/src/agent/outputCondenser.ts
//
// Big command output (journalctl, docker logs, a long build, `cat` of a huge
// log) is condensed before the main model reads it. The user still sees the
// full output in the stream; the model gets:
//   1. the error/warning lines, verbatim and de-duplicated ("12× …"),
//   2. a short digest from the cheap utility model (what matters for the task),
//   3. the first and last lines verbatim.
// A 65,000-token journal becomes ~2,500 tokens for the expensive model.

export const CONDENSE_TOOLS = new Set(["terminal", "run_command", "ssh_exec", "read_process_logs"]);

export function condenseThreshold(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.ORVYN_CONDENSE_OVER_CHARS);
  return Number.isFinite(n) && n > 0 ? n : 12_000;
}

export function shouldCondense(toolName: string, output: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return CONDENSE_TOOLS.has(toolName) && String(output ?? "").length > condenseThreshold(env);
}

const SIGNAL = /\b(error|errors|err\b|fail(ed|ure)?|fatal|panic|exception|traceback|denied|refused|timed? ?out|timeout|critical|crit\b|emerg|alert|warn(ing)?|segfault|killed|oom|out of memory|no space left|unreachable|502|503|504|exit (code|status) [1-9])/i;
const NOISE = /^\s*$/;

/** Error and warning lines, verbatim, de-duplicated with counts (timestamps and numbers normalised for grouping). */
export function signalLines(output: string, max = 80): string[] {
  const groups = new Map<string, { line: string; count: number }>();
  for (const raw of String(output).split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (NOISE.test(line) || !SIGNAL.test(line)) continue;
    const key = line
      .replace(/^\S+\s+\d+\s+[\d:]+\s+\S+\s+/, "")          // syslog prefix: "Sep 25 10:01:02 host "
      .replace(/\d{4}-\d{2}-\d{2}[T ][\d:.,]+Z?/g, "<time>")
      .replace(/\b\d+\b/g, "<n>")
      .slice(0, 300);
    const hit = groups.get(key);
    if (hit) hit.count++;
    else groups.set(key, { line: line.slice(0, 400), count: 1 });
  }
  return [...groups.values()].slice(0, max).map((g) => (g.count > 1 ? `${g.count}× ${g.line}` : g.line));
}

function headTail(output: string, head = 20, tail = 40): { head: string; tail: string } {
  const lines = String(output).split(/\r?\n/);
  if (lines.length <= head + tail) return { head: lines.join("\n").slice(0, 6000), tail: "" };
  return { head: lines.slice(0, head).join("\n").slice(0, 3000), tail: lines.slice(-tail).join("\n").slice(-6000) };
}

export interface CondenseModel {
  generate(req: { messages: { role: "system" | "user"; content: string }[]; temperature?: number }): Promise<{ content?: string | null; usage?: { promptTokens: number; completionTokens: number } }>;
}

const DIGEST_PROMPT = [
  "You condense command output for an engineer who is working on the task below and cannot read the whole output.",
  "Report only what matters for the task: the errors and warnings (quote the key lines exactly, with timestamps), what failed and when, status lines, exit codes, and key numbers (disk %, memory, ports, versions, counts). Collapse repeats as \"N× …\".",
  "No advice, no guesses, no preamble. Plain text, at most 350 words.",
].join("\n");

/** What the model reads instead of the full output. */
export function condensedText(input: { raw: string; command?: string; digest?: string | null; modelId?: string }): string {
  const { head, tail } = headTail(input.raw);
  const signals = signalLines(input.raw);
  const parts = [
    `[ORVYN condensed this output for you: ${input.raw.length.toLocaleString("en-US")} characters, ${input.raw.split(/\r?\n/).length.toLocaleString("en-US")} lines. The user sees it in full. If you need a part that is not here, run a narrower command (grep, tail -n, --since).]`,
  ];
  if (input.digest?.trim()) parts.push(`DIGEST${input.modelId ? ` (by ${input.modelId})` : ""}:\n${input.digest.trim()}`);
  parts.push(signals.length ? `ERROR/WARNING LINES (verbatim, de-duplicated):\n${signals.join("\n")}` : "ERROR/WARNING LINES: none found.");
  parts.push(`FIRST LINES:\n${head}`);
  if (tail) parts.push(`LAST LINES:\n${tail}`);
  return parts.join("\n\n");
}

/** Condense with the utility model; falls back to the verbatim extract when there is no model or it fails. */
export async function condenseOutput(input: { raw: string; command?: string; goal: string; model?: CondenseModel; modelId?: string }): Promise<{ text: string; usage?: { promptTokens: number; completionTokens: number }; digested: boolean }> {
  let digest: string | null = null;
  let usage: { promptTokens: number; completionTokens: number } | undefined;
  if (input.model) {
    const raw = input.raw.length > 120_000 ? `${input.raw.slice(0, 20_000)}\n…\n${input.raw.slice(-100_000)}` : input.raw;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const reply = await Promise.race([
        input.model.generate({
          temperature: 0,
          messages: [
            { role: "system", content: DIGEST_PROMPT },
            { role: "user", content: `Task: ${input.goal.slice(0, 1500)}\nCommand: ${input.command ?? "(tool output)"}\n\nOutput:\n${raw}` },
          ],
        }),
        new Promise<null>((r) => { timer = setTimeout(() => r(null), 45_000); }),
      ]);
      digest = reply?.content ? String(reply.content).slice(0, 4000) : null;
      usage = reply?.usage;
    } catch {
      digest = null;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  return { text: condensedText({ raw: input.raw, command: input.command, digest, modelId: digest ? input.modelId : undefined }), usage, digested: Boolean(digest) };
}
