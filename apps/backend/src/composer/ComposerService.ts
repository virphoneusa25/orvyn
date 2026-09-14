// apps/backend/src/composer/ComposerService.ts
import { promises as fs } from "fs";
import * as path from "path";
import { ModelService } from "../services/ModelService";
import { diffLines, diffStats, DiffLine } from "./diff";

export interface ComposerFileChange {
  path: string;
  before: string; // "" if new file
  after: string;
  isNew: boolean;
  diff: DiffLine[];
  additions: number;
  deletions: number;
}

export interface ComposerPlan {
  summary: string;
  files: ComposerFileChange[];
  totals: { filesChanged: number; additions: number; deletions: number };
}

function resolveSafe(projectRoot: string, relativePath: string): string {
  const resolved = path.resolve(projectRoot, relativePath);
  if (!resolved.startsWith(path.resolve(projectRoot))) {
    throw new Error(`Path "${relativePath}" escapes the project root — refused`);
  }
  return resolved;
}

async function readIfExists(target: string): Promise<{ content: string; existed: boolean }> {
  try {
    return { content: await fs.readFile(target, "utf-8"), existed: true };
  } catch {
    return { content: "", existed: false };
  }
}

// Model contract: respond with ONLY a JSON object of shape
// { "summary": string, "files": [{ "path": string, "content": string }] }
// "content" is the FULL new file content (not a patch) — simplest contract
// for a model to satisfy correctly, at the cost of larger responses.
function buildComposerPrompt(instruction: string, rules?: string): string {
  return [
    "You are ORVYN's Composer. The user wants a multi-file code change.",
    rules ? `Project rules:\n${rules}` : "",
    "Respond with ONLY a single JSON object, no prose, no markdown fences:",
    `{"summary": "one-line description", "files": [{"path": "relative/path.ts", "content": "full new file content"}]}`,
    `User request: ${instruction}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

function extractJson(raw: string): any {
  // Models (and our mock) sometimes wrap JSON in ```json fences despite
  // instructions — strip those before parsing rather than failing outright.
  const cleaned = raw.replace(/```json|```/g, "").trim();
  return JSON.parse(cleaned);
}

export class ComposerService {
  constructor(private modelService: ModelService) {}

  async plan(projectRoot: string, instruction: string, rules?: string): Promise<ComposerPlan> {
    const provider = this.modelService.router.resolve("code");
    const response = await provider.generate({
      messages: [{ role: "user", content: buildComposerPrompt(instruction, rules) }],
    });

    let parsed: { summary?: string; files?: { path: string; content: string }[] };
    try {
      parsed = extractJson(response.content);
    } catch (err: any) {
      throw new Error(
        `Model "${provider.config.id}" did not return valid Composer JSON: ${err.message}. Raw output: ${response.content.slice(0, 200)}`
      );
    }

    if (!Array.isArray(parsed.files) || parsed.files.length === 0) {
      throw new Error("Model response had no files to change.");
    }

    const files: ComposerFileChange[] = [];
    for (const f of parsed.files) {
      const target = resolveSafe(projectRoot, f.path);
      const { content: before, existed } = await readIfExists(target);
      const diff = diffLines(before, f.content);
      const stats = diffStats(diff);
      files.push({
        path: f.path,
        before,
        after: f.content,
        isNew: !existed,
        diff,
        additions: stats.additions,
        deletions: stats.deletions,
      });
    }

    const totals = files.reduce(
      (acc, f) => ({
        filesChanged: acc.filesChanged + 1,
        additions: acc.additions + f.additions,
        deletions: acc.deletions + f.deletions,
      }),
      { filesChanged: 0, additions: 0, deletions: 0 }
    );

    return { summary: parsed.summary ?? instruction, files, totals };
  }

  // Apply is a direct, explicit user action (the Apply button) — it does
  // not go through the tool-permission "ask" gate again; clicking Apply
  // in the UI *is* the approval.
  async apply(projectRoot: string, files: { path: string; content: string }[]): Promise<string[]> {
    const written: string[] = [];
    for (const f of files) {
      const target = resolveSafe(projectRoot, f.path);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, f.content, "utf-8");
      written.push(f.path);
    }
    return written;
  }
}
