# ORVYN testing

## Why this changed

The root `npm test` script used to be a hardcoded allowlist of ~100 explicit
`dist/**` paths. Two failure modes followed from that:

1. **Tests that existed never ran.** A test file not pasted into the allowlist was
   silently skipped forever. At commit `b54f389`, **26 of 270 test files** were in
   this state, including `routes/cloudWorkbench`, `routes/signupLegal`,
   `routes/workerAdmission`, `middleware/accountReady`, the whole of
   `apps/web/src/lib` except one file, `apps/worker`, and `packages/ai-core`.
2. **Tests that no longer existed still ran.** `tsc` does not delete output for
   removed or renamed sources, so a stale `dist/*.test.js` kept executing. PR #74
   fixed this for `apps/backend`; this change extends it to `apps/worker`.

A pass count from the old harness therefore told you nothing, because the
denominator was whatever someone last remembered to edit by hand.

## How tests are found now

`scripts/test/run-tests.mjs` discovers every `*.test.ts` / `*.test.tsx` under
`apps/*/src` and `packages/*/src` **from git**, not from a filesystem walk. Git is
the source of truth because it cannot wander into `node_modules` or `dist`, and
cannot pick up a stale compiled artifact.

**New test files run automatically.** No registration step. If you add a test file
and commit it, it runs.

Untracked test files are reported and fail the run, so a test that was written but
never committed cannot masquerade as covered.

## Tiers

Defined in `scripts/test/tiers.json`. A file lands in the first tier whose `match`
globs it; anything unmatched falls into `unit`.

| Tier | Runs by default | Needs | Per-file timeout |
|---|---|---|---|
| `unit` | yes | nothing | 60s |
| `integration` | no | `ORVYN_PG_URL` | 120s |
| `browser` | no | `ORVYN_BROWSER_TESTS` | 180s |
| `network` | no | `ORVYN_NETWORK_TESTS` | 16m |
| `acceptance` | no | `ORVYN_ACCEPTANCE` | per script |

`browser` and `integration` currently match no files, and that is accurate rather
than unfinished. ORVYN has no test *file* that is wholly service-dependent.
Service-dependent *cases* sit inside otherwise-deterministic files and gate
themselves, e.g.:

```ts
test("real Postgres: …", { skip: !integration }, async () => { … })
```

`node:test` reports those as skipped, and the runner surfaces them as **SKIPPED**
with the env var that would enable them. They are never counted as passing. The
same files are re-run with `ORVYN_PG_URL` set against a real `postgres:16` service
by `.github/workflows/postgres-production-mirror.yml` — that is the live
integration tier today, and it is deliberate rather than duplicate execution.

When a genuinely service-only test file appears, add a glob to that tier's `match`.

## Reporting

Four outcomes are reported separately and never collapsed:

- **PASS** — executed, all cases passed.
- **FAIL** — executed, at least one case failed, or the process exited non-zero.
- **SKIPPED** — executed, but every case gated itself off.
- **BLOCKED** — *not executed*: its tier was requested but a prerequisite was
  missing, or the compiled artifact was absent after a build.

A **TIMEOUT** names the exact file that hung, with its timeout. The CI step also
has its own 12-minute bound under the existing 20-minute job cap, so a hang is
attributable to a step rather than consuming the whole job.

A build failure is reported as a build failure. Zero executed tests is never a pass.

The run ends with a reconciliation check: discovered must equal
executed + blocked + excluded + not-selected. A mismatch exits `2` as a harness
error, so the runner cannot quietly lose a file.

## Exclusions

`exclusions` in `tiers.json` is currently **empty** — nothing should be prevented
from running. To exclude a file you must supply a reason:

```json
{ "path": "apps/x/src/y.test.ts", "reason": "why", "owner": "team", "reviewBy": "2026-12-31" }
```

The runner **fails** if an exclusion has no reason, or if it points at a file that
no longer exists. Exclusions cannot rot unnoticed.

Note: `apps/desktop/tsconfig.json` excludes `src/renderer/**/*.test.ts` from the
`tsc` **build**. That is not a run exclusion — those files execute here via
`node --experimental-strip-types`.

## Commands

```bash
npm test                  # unit tier (the CI gate)
npm run test:list         # discovery report only, nothing executed
npm run test:all          # every tier; unavailable ones reported as BLOCKED
npm run test:ci           # unit tier + reports/test-report.json
npm run test:integration  # needs ORVYN_PG_URL
npm run test:browser      # needs ORVYN_BROWSER_TESTS
npm run test:network      # needs ORVYN_NETWORK_TESTS

node scripts/test/run-tests.mjs --tier=unit,integration --concurrency=8
node scripts/test/run-tests.mjs --no-build   # local only: reuse existing dist
```

`apps/backend` and `apps/worker` compile tests into `dist/` and run the `.js`.
Both have a `prebuild` that removes `dist/` first, so stale artifacts cannot run.
`apps/desktop`, `apps/web` and `packages/ai-core` run their `.ts` directly.

## Adding a test

Write `foo.test.ts` next to the code, commit it. That's all. If it needs a live
service, gate the cases with an env check so the file stays in the `unit` tier and
reports SKIPPED without it — or, if the whole file is service-only, add a glob to
the right tier in `tiers.json`.
