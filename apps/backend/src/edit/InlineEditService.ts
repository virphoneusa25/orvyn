// apps/backend/src/edit/InlineEditService.ts
//
// Powers Ctrl+K: the user selects code, describes a change in plain language,
// and gets back a rewritten version to accept or reject as a diff. Unlike
// Composer (which spans files), this is scoped to one selection so it can be
// fast and predictable.

import { ModelService } from "../services/ModelService";
import { diffLines, diffStats, DiffLine } from "../composer/diff";

export interface InlineEditRequest {
  /** The exact text the user selected in the editor. */
  selection: string;
  instruction: string;
  /** Full file, so the model can honour surrounding imports/conventions. */
  fileContent?: string;
  filePath?: string;
  language?: string;
  rules?: string;
}

export interface InlineEditResult {
  original: string;
  edited: string;
  diff: DiffLine[];
  additions: number;
  deletions: number;
}

// The model must return ONLY replacement code. Anything else (prose, fences)
// would be inserted verbatim into the user's file, so we both instruct against
// it and strip it defensively below.
function buildPrompt(req: InlineEditRequest): string {
  const parts = [
    "You are performing an inline code edit inside an editor.",
    "Rewrite ONLY the selected code according to the instruction.",
    "",
    "Rules for your output:",
    "- Return ONLY the replacement code. No explanation, no commentary.",
    "- Do NOT wrap the output in markdown code fences.",
    "- Preserve the original indentation style and surrounding conventions.",
    "- If the instruction cannot be applied, return the selection unchanged.",
  ];
  if (req.rules) parts.push("", `Project rules:\n${req.rules}`);
  if (req.filePath) parts.push("", `File: ${req.filePath}`);
  if (req.fileContent && req.fileContent.length < 12000) {
    parts.push("", `Full file for context:\n${req.fileContent}`);
  }
  parts.push(
    "",
    `Selected code${req.language ? ` (${req.language})` : ""}:\n${req.selection}`,
    "",
    `Instruction: ${req.instruction}`
  );
  return parts.join("\n");
}

// Models frequently ignore "no fences". Strip them rather than corrupting the
// user's file with ``` lines.
function stripFences(raw: string): string {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/^```[\w]*\n([\s\S]*?)```$/);
  if (fenced) return fenced[1].replace(/\n$/, "");
  return trimmed;
}

export class InlineEditService {
  constructor(private modelService: ModelService) {}

  async edit(req: InlineEditRequest): Promise<InlineEditResult> {
    if (!req.selection?.trim()) throw new Error("Nothing selected to edit.");
    if (!req.instruction?.trim()) throw new Error("No instruction provided.");

    const provider = this.modelService.router.resolve("code");
    const response = await provider.generate({
      messages: [{ role: "user", content: buildPrompt(req) }],
      temperature: 0.1, // low: inline edits should be deterministic, not creative
    });

    const edited = stripFences(response.content);
    const diff = diffLines(req.selection, edited);
    const stats = diffStats(diff);

    return {
      original: req.selection,
      edited,
      diff,
      additions: stats.additions,
      deletions: stats.deletions,
    };
  }
}
