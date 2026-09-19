// apps/backend/src/ai/tools/diagnosticsTools.ts
//
// Verification tools for the Testing Agent (and anyone else): typecheck,
// tests, lint. They detect what the project actually supports and return a
// typed, honest error when it supports nothing — never a fake green result.

import { promises as fs } from "fs";
import * as path from "path";
import { AITool, ToolResult } from "../ToolTypes";
import { execCapture } from "./execCapture";

const RUN_TIMEOUT_MS = 5 * 60_000;
const MAX_OUTPUT = 20_000;

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function packageScripts(projectRoot: string): Promise<Record<string, string>> {
  try {
    const raw = await fs.readFile(path.join(projectRoot, "package.json"), "utf8");
    return JSON.parse(raw).scripts ?? {};
  } catch {
    return {};
  }
}

function clip(s: string): string {
  return s.length > MAX_OUTPUT ? s.slice(0, MAX_OUTPUT) + "\n…(truncated)" : s;
}

async function runTypecheck(projectRoot: string, project?: string): Promise<ToolResult> {
  const tsconfig = project
    ? path.join(projectRoot, project, "tsconfig.json")
    : path.join(projectRoot, "tsconfig.json");
  if (!(await exists(tsconfig))) {
    return {
      ok: false,
      error: `No tsconfig.json found at ${path.dirname(tsconfig)} — TypeScript diagnostics unavailable for this project.`,
    };
  }
  const cmd = project ? `npx tsc --noEmit -p "${project}"` : "npx tsc --noEmit";
  const out = await execCapture(cmd, projectRoot, RUN_TIMEOUT_MS);
  const text = `${out.stdout}\n${out.stderr}`.trim();
  if (out.code === 0) return { ok: true, output: "Typecheck passed: no errors." };
  return { ok: true, output: clip(`Typecheck found problems (exit ${out.code}):\n${text}`) };
}

export function makeGetDiagnosticsTool(projectRoot: string): AITool {
  return {
    name: "get_diagnostics",
    description:
      "Get project-wide compiler diagnostics (TypeScript: tsc --noEmit). Optional `project` = subfolder containing a tsconfig (e.g. apps/backend). Returns errors with file:line.",
    parameters: {
      type: "object",
      properties: {
        project: { type: "string", description: "Subfolder with the tsconfig.json to check (optional)" },
      },
    },
    defaultPermission: "allowed",
    execute: (args) => runTypecheck(projectRoot, args.project ? String(args.project) : undefined),
  };
}

export function makeRunTypecheckTool(projectRoot: string): AITool {
  return {
    name: "run_typecheck",
    description: "Run the TypeScript compiler in check mode (alias of get_diagnostics with the same options).",
    parameters: {
      type: "object",
      properties: {
        project: { type: "string", description: "Subfolder with the tsconfig.json to check (optional)" },
      },
    },
    defaultPermission: "ask",
    execute: (args) => runTypecheck(projectRoot, args.project ? String(args.project) : undefined),
  };
}

export function makeRunTestsTool(projectRoot: string): AITool {
  return {
    name: "run_tests",
    description:
      "Run the project's test suite (package.json `test` script, or pytest if a Python project). Optional filter narrows to matching tests.",
    parameters: {
      type: "object",
      properties: {
        filter: { type: "string", description: "Test name/path filter passed to the runner (optional)" },
      },
    },
    defaultPermission: "ask",
    async execute(args): Promise<ToolResult> {
      const scripts = await packageScripts(projectRoot);
      const filter = args.filter ? String(args.filter) : "";
      let cmd: string | null = null;
      if (scripts.test && !/no test specified/i.test(scripts.test)) {
        cmd = filter ? `npm test -- ${filter}` : "npm test";
      } else if ((await exists(path.join(projectRoot, "pytest.ini"))) || (await exists(path.join(projectRoot, "pyproject.toml")))) {
        cmd = filter ? `python -m pytest -k "${filter}"` : "python -m pytest";
      }
      if (!cmd) {
        return {
          ok: false,
          error: "No test runner found: package.json has no real `test` script and no pytest config exists.",
        };
      }
      const out = await execCapture(cmd, projectRoot, RUN_TIMEOUT_MS);
      const text = clip(`${out.stdout}\n${out.stderr}`.trim());
      return { ok: true, output: `$ ${cmd}\nexit ${out.code}\n\n${text}` };
    },
  };
}

export function makeRunLinterTool(projectRoot: string): AITool {
  return {
    name: "run_linter",
    description: "Run the project's linter (package.json `lint` script). Reports problems; never auto-fixes.",
    parameters: { type: "object", properties: {} },
    defaultPermission: "ask",
    async execute(): Promise<ToolResult> {
      const scripts = await packageScripts(projectRoot);
      if (!scripts.lint) {
        return { ok: false, error: "No `lint` script in package.json — linting unavailable for this project." };
      }
      const out = await execCapture("npm run lint", projectRoot, RUN_TIMEOUT_MS);
      const text = clip(`${out.stdout}\n${out.stderr}`.trim());
      return { ok: true, output: `$ npm run lint\nexit ${out.code}\n\n${text}` };
    },
  };
}
