export interface InstructionNormalization {
  kind: string;
  before: string;
  after: string;
}

export interface NormalizedInstructions {
  text: string;
  changes: InstructionNormalization[];
}

const PROVENANCE = /copyright|derived from|https?:\/\/|spdx-license|mit license|\(c\)/i;

function remember(changes: InstructionNormalization[], kind: string, before: string, after: string): string {
  if (before !== after) changes.push({ kind, before, after });
  return after;
}

/** Rewrite platform-specific execution wording. Domain steps and attribution stay intact. */
export function normalizeSkillInstructions(instructions: string): NormalizedInstructions {
  const changes: InstructionNormalization[] = [];
  const lines = instructions.split("\n").map((line) => {
    if (PROVENANCE.test(line)) return line;
    let next = line;
    next = remember(changes, "claude-code", next, next.replace(/Claude\.ai/g, "ORVYN").replace(/Claude Code/g, "ORVYN"));
    next = remember(changes, "ask-user", next, next.replace(/AskUserQuestion/g, "ask the user in the conversation"));
    next = remember(changes, "todo", next, next.replace(/\bTodoWrite\b/g, "the task list in the reply"));
    next = remember(changes, "notebook", next, next.replace(/\bNotebookEdit\b/g, "edit_file"));
    next = remember(changes, "bash-tool", next, next.replace(/\bBash tool\b/g, "terminal tool").replace(/\buse Bash\b/g, "use the terminal tool"));
    next = remember(changes, "slash-command", next, next.replace(/\/cs:([a-z0-9-]+)/gi, "the ORVYN workflow ($1)"));
    return next;
  });
  return { text: lines.join("\n"), changes };
}
