// §7 — a structured plan exists before the first edit. The runtime derives
// a skeleton from what it already knows (instruction, workspace files,
// canonical verification commands); the model confirms or refines it in its
// first turn. The plan is machine-owned state (emitted as agent.plan), not
// free narration.

import type { DiscoveredCommands } from "./testDiscovery";

export interface MissionPlan {
  objective: string;
  files_to_inspect: string[];
  likely_files_to_edit: string[];
  verification_strategy: string[];
  risks: string[];
}

export function planSkeleton(input: {
  instruction: string;
  category: string;
  knownFiles: string[];
  commands?: DiscoveredCommands;
  website: boolean;
}): MissionPlan {
  const objective = input.instruction.trim().split(/\n|\.(?=\s|$)/)[0]!.slice(0, 200);
  const files = input.knownFiles.map((f) => f.replace(/^\.?\//, ""));
  const relevant = (test: RegExp) => files.filter((f) => test.test(f)).slice(0, 6);

  const files_to_inspect = input.website
    ? relevant(/^(index\.html|styles\.css|style\.css|main\.(js|ts)x?|assets\/|public\/)/i)
    : relevant(/^(package\.json|README|src\/|app\/|lib\/|main\.|index\.)/i);
  if (files.length && files_to_inspect.length === 0) files_to_inspect.push(...files.slice(0, 3));

  const verification_strategy: string[] = input.website
    ? ["open the canonical preview URL", "browser_screenshot of the changed area", "browser_console_errors must be clean"]
    : [
        input.commands?.testCommand ? `run ${input.commands.testCommand}` : "",
        input.commands?.buildCommand ? `run ${input.commands.buildCommand} when the change affects the build` : "",
        "read the edited file back after the change",
      ].filter(Boolean);

  const risks = input.website
    ? ["scope creep beyond the requested change", "breaking the existing stylesheet links"]
    : ["editing files that were not read first", "rewriting whole files instead of targeted patches"];

  return { objective, files_to_inspect, likely_files_to_edit: [], verification_strategy, risks };
}

/** The note the model receives BEFORE its first turn on write-capable tasks. */
export function planPromptNote(plan: MissionPlan, commands?: DiscoveredCommands): string {
  const canonical = commands?.testCommand
    ? ` This project's canonical verification is ${commands.testCommand}${commands.buildCommand ? ` / ${commands.buildCommand}` : ""} (${commands.source}) — use those commands for verification, never invented one-off scripts.`
    : "";
  return [
    `[Runtime plan — confirm or refine this in your FIRST reply, before any file edit:]`,
    `objective: ${plan.objective}`,
    plan.files_to_inspect.length ? `files to inspect: ${plan.files_to_inspect.join(", ")}` : "files to inspect: (discover with the project tools)",
    plan.verification_strategy.length ? `verification: ${plan.verification_strategy.join("; ")}` : "",
    plan.risks.length ? `risks to avoid: ${plan.risks.join("; ")}` : "",
    `State the plan (objective, files, verification) in one short block, then execute it. Do not write any file before the plan appears in your reply.${canonical}`,
  ]
    .filter(Boolean)
    .join("\n");
}
