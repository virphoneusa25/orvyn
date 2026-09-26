import * as fs from "fs";
import * as path from "path";

/** Fields read from SKILL.md frontmatter when the external package provides them. */
export interface ExternalSkillFrontmatter {
  name: string;
  description: string;
  license: string;
  version: string;
  author: string;
  category: string;
  requiredToolNames: string[];
  optionalToolNames: string[];
}

export interface ParsedExternalSkill {
  dir: string;
  /** Original SKILL.md bytes. Import copies these unchanged. */
  rawMarkdown: string;
  frontmatter: ExternalSkillFrontmatter;
  references: string[];
  templates: string[];
  scripts: string[];
  licenseFiles: string[];
}

const LICENSE_NAMES = new Set(["LICENSE", "LICENSE.md", "LICENSE.txt", "LICENCE", "LICENCE.md", "COPYING", "COPYING.md"]);

function unquote(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith("\"") && trimmed.endsWith("\"")) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1).replace(/\\"/g, "\"").replace(/\\'/g, "'");
  }
  return trimmed;
}

interface Frame {
  indent: number;
  value: Record<string, unknown> | unknown[];
  parent?: Record<string, unknown>;
  key?: string;
}

/** A small YAML subset: scalars, nested maps, and scalar lists. Enough for SKILL.md frontmatter. */
export function parseFrontmatterBlock(text: string): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  const stack: Frame[] = [{ indent: -1, value: root }];
  for (const rawLine of text.split(/\r?\n/)) {
    if (!rawLine.trim() || rawLine.trim().startsWith("#")) continue;
    const indent = rawLine.match(/^ */)?.[0].length ?? 0;
    const line = rawLine.trim();
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop();
    const frame = stack[stack.length - 1];
    if (line.startsWith("- ")) {
      let list = frame.value;
      if (!Array.isArray(list)) {
        if (frame.parent && frame.key && Object.keys(frame.value).length === 0) {
          const created: unknown[] = [];
          frame.parent[frame.key] = created;
          frame.value = created;
          list = created;
        } else {
          throw new Error("Frontmatter list item is not inside a list.");
        }
      }
      list.push(unquote(line.slice(2)));
      continue;
    }
    const splitAt = line.indexOf(":");
    if (splitAt <= 0) throw new Error(`Frontmatter line is not a field: ${line}`);
    if (Array.isArray(frame.value)) throw new Error("Frontmatter field is nested inside a list.");
    const key = line.slice(0, splitAt).trim();
    const rest = line.slice(splitAt + 1).trim();
    if (!rest) {
      const child: Record<string, unknown> = {};
      frame.value[key] = child;
      stack.push({ indent, value: child, parent: frame.value, key });
      continue;
    }
    frame.value[key] = unquote(rest);
  }
  return root;
}

function pickString(source: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  const nested = source.metadata;
  if (nested && typeof nested === "object" && !Array.isArray(nested)) {
    const row = nested as Record<string, unknown>;
    for (const key of keys) {
      const value = row[key];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
  }
  return "";
}

function scalarTokens(value: unknown): string[] {
  if (typeof value === "string") return value.split(/[\s,]+/).map((item) => item.trim()).filter(Boolean);
  if (Array.isArray(value)) {
    return value.flatMap((item) => (typeof item === "string" && item.trim() ? [item.trim()] : []));
  }
  return [];
}

function collectTools(source: Record<string, unknown>): { required: string[]; optional: string[] } {
  const required: string[] = [];
  const optional: string[] = [];
  const tools = source.tools;
  if (Array.isArray(tools) || typeof tools === "string") required.push(...scalarTokens(tools));
  else if (tools && typeof tools === "object") {
    const row = tools as Record<string, unknown>;
    required.push(...scalarTokens(row.required));
    optional.push(...scalarTokens(row.optional));
  }
  required.push(...scalarTokens(source["required-tools"]), ...scalarTokens(source.required_tools));
  optional.push(
    ...scalarTokens(source["optional-tools"]),
    ...scalarTokens(source.optional_tools),
    ...scalarTokens(source["allowed-tools"]),
    ...scalarTokens(source.allowed_tools),
  );
  const seen = new Set<string>();
  const unique = (names: string[]) => names.filter((name) => {
    if (seen.has(name)) return false;
    seen.add(name);
    return true;
  });
  const requiredUnique = unique(required);
  return { required: requiredUnique, optional: unique(optional) };
}

function listRegularFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  const walk = (current: string, rel: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const child = rel ? path.join(rel, entry.name) : entry.name;
      const abs = path.join(current, entry.name);
      if (entry.isDirectory()) walk(abs, child);
      else if (entry.isFile()) out.push(child.split(path.sep).join("/"));
    }
  };
  walk(dir, "");
  return out.sort();
}

/**
 * Read an external skill directory. This only reads files.
 * Scripts are listed and never spawned.
 */
export function parseExternalSkill(dir: string): ParsedExternalSkill {
  const skillPath = path.join(dir, "SKILL.md");
  if (!fs.existsSync(skillPath) || !fs.statSync(skillPath).isFile()) {
    throw new Error("SKILL.md is missing.");
  }
  const rawMarkdown = fs.readFileSync(skillPath, "utf8");
  const match = rawMarkdown.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  const parsed = match ? parseFrontmatterBlock(match[1]) : {};
  const tools = collectTools(parsed);
  const names = fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && LICENSE_NAMES.has(entry.name))
    .map((entry) => entry.name)
    .sort();
  return {
    dir,
    rawMarkdown,
    frontmatter: {
      name: pickString(parsed, ["name"]),
      description: pickString(parsed, ["description"]),
      license: pickString(parsed, ["license"]),
      version: pickString(parsed, ["version"]),
      author: pickString(parsed, ["author"]),
      category: pickString(parsed, ["category"]),
      requiredToolNames: tools.required,
      optionalToolNames: tools.optional,
    },
    references: listRegularFiles(path.join(dir, "references")),
    templates: listRegularFiles(path.join(dir, "templates")),
    scripts: listRegularFiles(path.join(dir, "scripts")),
    licenseFiles: names,
  };
}
