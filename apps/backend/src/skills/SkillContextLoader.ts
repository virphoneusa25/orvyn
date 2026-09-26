import * as fs from "fs";
import * as path from "path";

/** A selected skill whose playbook is already in memory. */
export interface LoadedSkillContext {
  id: string;
  name: string;
  instructions: string;
  dir: string;
}

const ON_DEMAND = "References, templates, and scripts stay on disk. Read a file under references/ or templates/ only when a step names that exact path.";

/** SKILL.md bodies for the selected skills. Reference, template, and script files are not inlined. */
export function buildSkillPrompt(selected: LoadedSkillContext[]): string {
  if (!selected.length) return "";
  const blocks = selected.map((skill) => {
    const body = skill.instructions.trim();
    return [`### ${skill.name}`, body, ON_DEMAND].filter(Boolean).join("\n");
  });
  return ["Active skills for this task:", ...blocks].join("\n\n");
}

function allowedReference(relativePath: string): string | null {
  const normalized = relativePath.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!normalized || normalized.includes("\0")) return null;
  const parts = normalized.split("/");
  if (parts.some((part) => part === ".." || part === ".")) return null;
  const root = parts[0];
  if (root !== "references" && root !== "templates") return null;
  if (parts.length < 2 || parts.some((part) => !part)) return null;
  return parts.join("/");
}

/**
 * Read one reference or template that belongs to the skill.
 * Paths outside references/ and templates/ are refused, including scripts.
 */
export function loadSkillReference(skill: { dir: string }, relativePath: string): string | null {
  const rel = allowedReference(relativePath);
  if (!rel) return null;
  const root = path.resolve(skill.dir);
  const target = path.resolve(root, rel);
  const prefix = root.endsWith(path.sep) ? root : root + path.sep;
  if (target !== root && !target.startsWith(prefix)) return null;
  try {
    if (!fs.statSync(target).isFile()) return null;
    return fs.readFileSync(target, "utf8");
  } catch {
    return null;
  }
}
