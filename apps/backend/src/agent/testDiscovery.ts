// §22-23 — discover the project's canonical test/build commands from its
// own manifests, so the agent verifies with `npm test` (or pytest / go test
// / make) instead of inventing ad-hoc `node -e` validation.

export interface DiscoveredCommands {
  testCommand?: string;
  buildCommand?: string;
  typecheckCommand?: string;
  lintCommand?: string;
  /** Where each command came from, e.g. "package.json scripts.test". */
  source: string;
}

interface WorkspaceFile {
  name: string;
  content?: string;
}

const TEST_SCRIPT_PRIORITY = ["test", "test:unit", "test:ci", "unit", "vitest", "jest", "mocha"];

export function discoverTestCommands(files: WorkspaceFile[]): DiscoveredCommands {
  const byName = new Map(files.map((f) => [f.name.replace(/^\.?\//, ""), f]));
  const pkg = byName.get("package.json");
  if (pkg?.content) {
    try {
      const scripts = (JSON.parse(pkg.content).scripts ?? {}) as Record<string, string>;
      const pick = (...names: string[]) => {
        for (const n of names) if (typeof scripts[n] === "string" && scripts[n].trim()) return n;
        return undefined;
      };
      const testKey = pick(...TEST_SCRIPT_PRIORITY);
      const buildKey = pick("build", "dist", "compile");
      const typeKey = pick("typecheck", "type-check", "tsc", "check");
      const lintKey = pick("lint", "eslint");
      if (testKey || buildKey || typeKey || lintKey) {
        return {
          testCommand: testKey ? `npm run ${testKey}` : undefined,
          buildCommand: buildKey ? `npm run ${buildKey}` : undefined,
          typecheckCommand: typeKey ? `npm run ${typeKey}` : undefined,
          lintCommand: lintKey ? `npm run ${lintKey}` : undefined,
          source: "package.json scripts",
        };
      }
    } catch { /* not valid JSON — keep looking */ }
  }
  const makefile = byName.get("Makefile") ?? byName.get("makefile");
  if (makefile?.content) {
    const mk = makefile.content;
    const has = (t: string) => new RegExp(`^${t}:`, "m").test(mk);
    return {
      testCommand: has("test") ? "make test" : has("check") ? "make check" : undefined,
      buildCommand: has("build") ? "make build" : undefined,
      source: "Makefile targets",
    };
  }
  if (byName.has("go.mod")) return { testCommand: "go test ./...", buildCommand: "go build ./...", source: "go.mod" };
  if (byName.has("Cargo.toml")) return { testCommand: "cargo test", buildCommand: "cargo build", source: "Cargo.toml" };
  const py = byName.has("pyproject.toml") || byName.has("pytest.ini") || (byName.has("requirements.txt") && files.some((f) => f.name.startsWith("tests/")));
  if (py) return { testCommand: "pytest -q", source: "python project files" };
  return { source: "none found" };
}
