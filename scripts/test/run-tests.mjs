#!/usr/bin/env node
// scripts/test/run-tests.mjs
//
// ORVYN test runner: discovers every test file from the source tree, assigns it
// to a tier, compiles from clean output, runs it, and reports PASS / FAIL /
// SKIPPED / BLOCKED separately.
//
// It replaces the hardcoded allowlist that used to live in the root package.json
// "test" script, under which 26 test files existed in src and never executed.
//
// Usage:
//   node scripts/test/run-tests.mjs                 # default tiers (unit)
//   node scripts/test/run-tests.mjs --tier=unit,integration
//   node scripts/test/run-tests.mjs --all           # every tier, blocked ones reported
//   node scripts/test/run-tests.mjs --list          # discovery report only, no execution
//   node scripts/test/run-tests.mjs --no-build      # reuse existing dist (local only)
//   node scripts/test/run-tests.mjs --json=out.json # machine-readable report
//   node scripts/test/run-tests.mjs --concurrency=8
//   node scripts/test/run-tests.mjs --filter=apps/web   # local scoping only
//
// Exit codes: 0 all good · 1 test failures · 2 harness/config error
//             (BLOCKED in a tier that was explicitly requested also exits 1)

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CONFIG_PATH = join(ROOT, "scripts", "test", "tiers.json");

// ─────────────────────────── args ───────────────────────────

const argv = process.argv.slice(2);
const flag = (name) => argv.some((a) => a === `--${name}`);
const value = (name) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};

const OPT = {
  tiers: value("tier")?.split(",").map((s) => s.trim()).filter(Boolean) ?? null,
  all: flag("all"),
  list: flag("list"),
  build: !flag("no-build"),
  json: value("json"),
  concurrency: Number(value("concurrency") ?? 4),
  filter: value("filter"),
};

// ─────────────────────────── helpers ───────────────────────────

const C = process.stdout.isTTY
  ? { dim: "\x1b[2m", red: "\x1b[31m", green: "\x1b[32m", yellow: "\x1b[33m", cyan: "\x1b[36m", bold: "\x1b[1m", off: "\x1b[0m" }
  : { dim: "", red: "", green: "", yellow: "", cyan: "", bold: "", off: "" };

function die(msg) {
  console.error(`${C.red}harness error:${C.off} ${msg}`);
  process.exit(2);
}

/** Minimal glob → RegExp. Supports ** , * and ? against POSIX-style paths. */
function globToRegExp(glob) {
  let out = "^";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        // `**/` consumes any number of path segments, including none.
        if (glob[i + 2] === "/") { out += "(?:.*/)?"; i += 2; } else { out += ".*"; i += 1; }
      } else {
        out += "[^/]*";
      }
    } else if (c === "?") out += "[^/]";
    else out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(out + "$");
}

const matchesAny = (path, globs) => globs.some((g) => globToRegExp(g).test(path));

function sh(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { cwd: ROOT, encoding: "utf8", shell: process.platform === "win32", ...opts });
}

// ─────────────────────────── discovery ───────────────────────────

/**
 * Source of truth is git, not a filesystem walk: it cannot wander into
 * node_modules, dist, or build output, and it cannot pick up a stale compiled
 * artifact. An untracked new test file is reported so it is never silently lost.
 */
function discover() {
  const tracked = sh("git", ["ls-files", "apps", "packages"]);
  if (tracked.status !== 0) die("git ls-files failed — run from inside the repository");

  const isTest = (p) => /\.test\.(ts|tsx|mts)$/.test(p);
  const inSrc = (p) => /^(apps|packages)\/[^/]+\/src\//.test(p);
  const files = tracked.stdout.split("\n").map((s) => s.trim()).filter(Boolean).filter((p) => isTest(p) && inSrc(p));

  const untracked = sh("git", ["ls-files", "--others", "--exclude-standard", "apps", "packages"])
    .stdout.split("\n").map((s) => s.trim()).filter((p) => p && isTest(p) && inSrc(p));

  return { files: [...new Set(files)].sort(), untracked };
}

// ─────────────────────────── workspace strategy ───────────────────────────

/**
 * How each workspace's tests are executed:
 *   compiled — tsc emits tests into dist/; we run the .js. Needs a clean build.
 *   source   — run the .ts directly under node's type stripping.
 */
const WORKSPACES = {
  // buildOrder matters: ai-core is a dependency of backend, and apps/web tests
  // import from apps/backend/dist, so backend must be built before web runs.
  "packages/ai-core": { strategy: "compiled", buildScript: "@orvyn/ai-core", buildOrder: 0 },
  "apps/backend": { strategy: "compiled", buildScript: "@orvyn/backend", buildOrder: 1 },
  "apps/worker": { strategy: "compiled", buildScript: "@orvyn/worker", buildOrder: 2 },
  // Type-stripped at runtime; no emit step. Desktop renderer tests are excluded
  // from the tsc build by apps/desktop/tsconfig.json and only run this way.
  "apps/desktop": { strategy: "source", buildOrder: 3 },
  "apps/web": { strategy: "source", buildOrder: 4, needsBuilt: ["apps/backend"] },
};

const workspaceOf = (p) => Object.keys(WORKSPACES).find((w) => p.startsWith(w + "/")) ?? null;

/** apps/backend/src/x/y.test.ts → apps/backend/dist/x/y.test.js */
const compiledPath = (p) => p.replace("/src/", "/dist/").replace(/\.test\.(ts|mts)$/, ".test.js");

// ─────────────────────────── config ───────────────────────────

function loadConfig() {
  if (!existsSync(CONFIG_PATH)) die(`missing ${relative(ROOT, CONFIG_PATH)}`);
  let cfg;
  try { cfg = JSON.parse(readFileSync(CONFIG_PATH, "utf8")); }
  catch (e) { die(`${relative(ROOT, CONFIG_PATH)} is not valid JSON: ${e.message}`); }
  if (!Array.isArray(cfg.tiers) || cfg.tiers.length === 0) die("tiers.json defines no tiers");
  for (const t of cfg.tiers) {
    if (!t.name) die("a tier has no name");
    if (!Array.isArray(t.match)) die(`tier "${t.name}" has no match array`);
  }
  if (!cfg.tiers.some((t) => t.name === cfg.defaultTier)) die(`defaultTier "${cfg.defaultTier}" is not a defined tier`);
  return cfg;
}

/**
 * Exclusions must be explicit, justified, and live. A stale exclusion (pointing
 * at a file that no longer exists) fails the run rather than rotting unnoticed.
 */
function resolveExclusions(cfg, files) {
  const errors = [];
  const excluded = new Map();
  for (const ex of cfg.exclusions ?? []) {
    if (!ex.path) { errors.push("an exclusion entry has no `path`"); continue; }
    if (!ex.reason || !ex.reason.trim()) { errors.push(`exclusion "${ex.path}" has no \`reason\` — every exclusion must say why`); continue; }
    if (ex.excludeFromTypecheckOnly) continue; // documented, but still runs
    if (!files.includes(ex.path)) { errors.push(`exclusion "${ex.path}" matches no discovered test file — remove it or fix the path`); continue; }
    excluded.set(ex.path, ex);
  }
  return { excluded, errors };
}

function assignTier(path, cfg) {
  for (const t of cfg.tiers) {
    if (t.match.length && matchesAny(path, t.match)) return t;
  }
  return cfg.tiers.find((t) => t.name === cfg.defaultTier);
}

const missingEnv = (tier) => (tier.requiresEnv ?? []).filter((v) => !process.env[v]);

// ─────────────────────────── build ───────────────────────────

function buildCompiledWorkspaces(needed) {
  // A source-strategy workspace can still import another workspace's compiled
  // output (apps/web tests import apps/backend/dist), so pull in its needsBuilt.
  const expanded = new Set(needed);
  for (const ws of needed) for (const dep of WORKSPACES[ws]?.needsBuilt ?? []) expanded.add(dep);
  const ordered = [...expanded].sort((a, b) => (WORKSPACES[a]?.buildOrder ?? 99) - (WORKSPACES[b]?.buildOrder ?? 99));

  const results = [];
  for (const ws of ordered) {
    const spec = WORKSPACES[ws];
    if (spec.strategy !== "compiled") continue;
    process.stdout.write(`${C.dim}building ${ws} (clean)…${C.off}\n`);
    // `prebuild` in each workspace removes dist/ first, so a renamed or deleted
    // source file cannot leave an executable artifact behind.
    const r = sh("npm", ["run", "build", "-w", spec.buildScript], { stdio: "inherit" });
    results.push({ workspace: ws, ok: r.status === 0 });
    if (r.status !== 0) return results;
  }
  return results;
}

// ─────────────────────────── execution ───────────────────────────

const TAP_RE = {
  pass: /^# pass (\d+)/m,
  fail: /^# fail (\d+)/m,
  skipped: /^# skipped (\d+)/m,
  todo: /^# todo (\d+)/m,
};

function runOne(unit) {
  return new Promise((done) => {
    const args = ["--test", "--test-reporter=tap"];
    if (unit.strategy === "source") args.push("--experimental-strip-types", "--no-warnings");
    args.push(unit.execPath);

    const started = Date.now();
    const child = spawn(process.execPath, args, { cwd: ROOT, encoding: "utf8" });
    let out = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, unit.timeoutMs);

    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));

    child.on("close", (code) => {
      clearTimeout(timer);
      const num = (re) => Number(out.match(re)?.[1] ?? 0);
      const counts = { pass: num(TAP_RE.pass), fail: num(TAP_RE.fail), skipped: num(TAP_RE.skipped) + num(TAP_RE.todo) };
      let status;
      if (timedOut) status = "TIMEOUT";
      else if (counts.fail > 0 || code !== 0) status = "FAIL";
      else if (counts.pass === 0 && counts.skipped > 0) status = "SKIPPED";
      else status = "PASS";
      done({ ...unit, status, counts, durationMs: Date.now() - started, output: status === "PASS" ? "" : out });
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      done({ ...unit, status: "FAIL", counts: { pass: 0, fail: 1, skipped: 0 }, durationMs: Date.now() - started, output: String(err) });
    });
  });
}

async function runPool(units, concurrency) {
  const results = [];
  let i = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, units.length)) }, async () => {
    while (i < units.length) {
      const unit = units[i++];
      const r = await runOne(unit);
      results.push(r);
      const mark =
        r.status === "PASS" ? `${C.green}·${C.off}`
        : r.status === "SKIPPED" ? `${C.yellow}s${C.off}`
        : r.status === "TIMEOUT" ? `${C.red}T${C.off}`
        : `${C.red}F${C.off}`;
      process.stdout.write(mark);
    }
  });
  await Promise.all(workers);
  process.stdout.write("\n");
  return results;
}

// ─────────────────────────── main ───────────────────────────

async function main() {
  const cfg = loadConfig();
  let { files, untracked } = discover();
  // --filter narrows a local run to one area. It never applies in CI (the npm
  // scripts do not pass it) so it cannot be used to quietly shrink the gate.
  if (OPT.filter) {
    const re = globToRegExp(OPT.filter);
    files = files.filter((f) => re.test(f) || f.includes(OPT.filter));
    console.log(`${C.yellow}--filter=${OPT.filter} active: scoped to ${files.length} files (NOT a full run)${C.off}`);
  }
  if (files.length === 0) die("discovered no test files — check the repository layout");

  const { excluded, errors: exclusionErrors } = resolveExclusions(cfg, files);

  // Assign every discovered file to exactly one tier. Dedupe is inherent: the
  // discovery set is a Set of paths and each path yields one unit.
  const assigned = files.map((path) => {
    const ws = workspaceOf(path);
    const tier = assignTier(path, cfg);
    return { path, workspace: ws, tier };
  });

  const unknownWorkspace = assigned.filter((a) => !a.workspace);

  const requested = OPT.all
    ? cfg.tiers.map((t) => t.name)
    : OPT.tiers ?? cfg.tiers.filter((t) => t.runByDefault).map((t) => t.name);

  for (const name of requested) {
    if (!cfg.tiers.some((t) => t.name === name)) die(`unknown tier "${name}"`);
  }

  // ── discovery report ──
  console.log(`\n${C.bold}ORVYN test discovery${C.off}`);
  console.log(`  discovered         ${files.length} test files`);
  console.log(`  excluded           ${excluded.size}${excluded.size ? "" : " (none)"}`);
  for (const [p, ex] of excluded) console.log(`    ${C.dim}- ${p} — ${ex.reason}${C.off}`);
  if (untracked.length) {
    console.log(`  ${C.yellow}untracked${C.off}          ${untracked.length} (not committed, will not run in CI)`);
    for (const p of untracked) console.log(`    ${C.yellow}? ${p}${C.off}`);
  }
  console.log(`\n${C.bold}Tiers${C.off}`);
  for (const t of cfg.tiers) {
    const inTier = assigned.filter((a) => a.tier.name === t.name && !excluded.has(a.path));
    const miss = missingEnv(t);
    const sel = requested.includes(t.name);
    const state = !sel ? `${C.dim}not requested${C.off}` : miss.length ? `${C.yellow}BLOCKED (needs ${miss.join(", ")})${C.off}` : `${C.cyan}selected${C.off}`;
    console.log(`  ${t.name.padEnd(12)} ${String(inTier.length).padStart(4)} files   ${state}`);
  }
  const acc = cfg.acceptance;
  if (acc) {
    const accMiss = (acc.requiresEnv ?? []).filter((v) => !process.env[v]);
    console.log(`  ${"acceptance".padEnd(12)} ${String(acc.scripts?.length ?? 0).padStart(4)} scripts ${accMiss.length ? `${C.yellow}BLOCKED (needs ${accMiss.join(", ")})${C.off}` : `${C.cyan}selected${C.off}`}`);
  }

  if (exclusionErrors.length) {
    console.error(`\n${C.red}Exclusion problems:${C.off}`);
    for (const e of exclusionErrors) console.error(`  - ${e}`);
    process.exit(2);
  }
  if (unknownWorkspace.length) {
    console.error(`\n${C.red}Test files in an unmapped workspace${C.off} — add it to WORKSPACES in run-tests.mjs:`);
    for (const a of unknownWorkspace) console.error(`  - ${a.path}`);
    process.exit(2);
  }
  if (OPT.list) { console.log(`\n${C.dim}--list: discovery only, nothing executed.${C.off}`); process.exit(0); }

  // ── split selected vs blocked ──
  const selected = [];
  const blocked = [];
  for (const a of assigned) {
    if (excluded.has(a.path)) continue;
    if (!requested.includes(a.tier.name)) continue;
    const miss = missingEnv(a.tier);
    if (miss.length) blocked.push({ ...a, reason: `missing env: ${miss.join(", ")}` });
    else selected.push(a);
  }

  // ── build ──
  const neededWorkspaces = [...new Set(selected.map((a) => a.workspace))];
  if (OPT.build && selected.length) {
    const builds = buildCompiledWorkspaces(neededWorkspaces);
    const failed = builds.find((b) => !b.ok);
    if (failed) {
      console.error(`\n${C.red}BUILD FAILED${C.off} in ${failed.workspace} — no tests were executed.`);
      console.error("Reporting this as a build failure, not as passing tests.");
      process.exit(1);
    }
  }

  // ── resolve executables ──
  const units = [];
  for (const a of selected) {
    const spec = WORKSPACES[a.workspace];
    const execPath = spec.strategy === "compiled" ? compiledPath(a.path) : a.path;
    if (!existsSync(join(ROOT, execPath))) {
      blocked.push({ ...a, reason: `expected artifact missing after build: ${execPath}` });
      continue;
    }
    units.push({ ...a, strategy: spec.strategy, execPath, timeoutMs: a.tier.timeoutMs ?? 60000 });
  }

  console.log(`\n${C.bold}Running${C.off} ${units.length} files · concurrency ${OPT.concurrency}`);
  const results = units.length ? await runPool(units, OPT.concurrency) : [];

  // ── report ──
  const by = (s) => results.filter((r) => r.status === s);
  const failures = [...by("FAIL"), ...by("TIMEOUT")];
  const totals = results.reduce((acc, r) => ({
    pass: acc.pass + r.counts.pass, fail: acc.fail + r.counts.fail, skipped: acc.skipped + r.counts.skipped,
  }), { pass: 0, fail: 0, skipped: 0 });

  console.log(`\n${C.bold}Results by tier${C.off}`);
  for (const name of requested) {
    const inTier = results.filter((r) => r.tier.name === name);
    const b = blocked.filter((x) => x.tier.name === name);
    if (!inTier.length && !b.length) continue;
    console.log(
      `  ${name.padEnd(12)} ` +
      `${C.green}${inTier.filter((r) => r.status === "PASS").length} pass${C.off}  ` +
      `${C.red}${inTier.filter((r) => r.status === "FAIL").length} fail${C.off}  ` +
      `${C.yellow}${inTier.filter((r) => r.status === "SKIPPED").length} skipped${C.off}  ` +
      `${C.red}${inTier.filter((r) => r.status === "TIMEOUT").length} timeout${C.off}  ` +
      `${C.yellow}${b.length} blocked${C.off}`
    );
  }

  if (failures.length) {
    console.log(`\n${C.red}${C.bold}Failures${C.off}`);
    for (const r of failures) {
      const why = r.status === "TIMEOUT" ? `TIMED OUT after ${r.timeoutMs}ms` : `${r.counts.fail} failing case(s)`;
      console.log(`\n  ${C.red}${r.status}${C.off} ${r.path}  ${C.dim}(${why})${C.off}`);
      const lines = r.output.split("\n").filter((l) => /^not ok |Error|AssertionError|ERR_|expected|actual/.test(l)).slice(0, 8);
      for (const l of lines) console.log(`      ${C.dim}${l.trim().slice(0, 160)}${C.off}`);
    }
  }

  if (blocked.length) {
    console.log(`\n${C.yellow}${C.bold}Blocked${C.off} ${C.dim}(not executed — NOT counted as passing)${C.off}`);
    const grouped = new Map();
    for (const b of blocked) grouped.set(b.reason, (grouped.get(b.reason) ?? 0) + 1);
    for (const [reason, n] of grouped) console.log(`  ${n} file(s) — ${reason}`);
  }

  const skippedFiles = by("SKIPPED").length;
  console.log(`\n${C.bold}Summary${C.off}`);
  console.log(`  files discovered   ${files.length}`);
  console.log(`  files executed     ${results.length}`);
  console.log(`  files blocked      ${blocked.length}`);
  console.log(`  files excluded     ${excluded.size}`);
  console.log(`  files not selected ${files.length - results.length - blocked.length - excluded.size}`);
  console.log(`  cases  ${C.green}${totals.pass} pass${C.off} · ${C.red}${totals.fail} fail${C.off} · ${C.yellow}${totals.skipped} skipped${C.off}  (${skippedFiles} wholly-skipped files)`);

  // Reconciliation: discovery must balance. A gap means the harness lost a file.
  const accounted = results.length + blocked.length + excluded.size +
    assigned.filter((a) => !excluded.has(a.path) && !requested.includes(a.tier.name)).length;
  if (accounted !== files.length) {
    console.error(`\n${C.red}UNACCOUNTED TESTS${C.off}: discovered ${files.length} but accounted for ${accounted}.`);
    process.exit(2);
  }

  if (OPT.json) {
    const out = resolve(ROOT, OPT.json);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify({
      commit: sh("git", ["rev-parse", "HEAD"]).stdout.trim(),
      discovered: files.length, executed: results.length, blocked: blocked.length, excluded: excluded.size,
      totals, requestedTiers: requested,
      files: results.map((r) => ({ path: r.path, tier: r.tier.name, status: r.status, counts: r.counts, durationMs: r.durationMs })),
      blockedFiles: blocked.map((b) => ({ path: b.path, tier: b.tier.name, reason: b.reason })),
      untracked,
    }, null, 2));
    console.log(`  json report        ${relative(ROOT, out)}`);
  }

  if (untracked.length) { console.error(`\n${C.red}Untracked test files present${C.off} — commit them or they will never run in CI.`); process.exit(1); }
  if (failures.length) process.exit(1);
  if (blocked.length && OPT.tiers) { console.error(`\n${C.red}A tier you explicitly requested was blocked.${C.off}`); process.exit(1); }
  console.log(`\n${C.green}${C.bold}OK${C.off}\n`);
}

main().catch((e) => die(e?.stack ?? String(e)));
