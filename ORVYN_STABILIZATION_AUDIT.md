# ORVYN stabilization audit

Stop-ship program started 2026-09-29. **Feature freeze:** only P0/P1 fixes land until every gate below passes.
Baseline for rollback: `e954e99` (origin/fix/core-agent-runtime before this change set).

Severity:

- P0 — data, security, billing or state corruption; a false claim of success.
- P1 — mission/runtime reliability.
- P2 — significant UX.
- P3 — polish.

Status:

- **Fixed** — code plus an automated test exist.
- **Fixed, test pending** — code exists, but the test needs production or a desktop sandbox.
- **Open** — not fixed yet.

"Other session" = the parallel stabilization session's commits.

## Findings

| # | Area | Finding | Sev | Root cause | Fix | Test | Status |
|---|---|---|---|---|---|---|---|
| 1 | Verification | ORION said "The desktop Firefox loaded it cleanly" while Firefox showed ORVYN's own start page | **P0** | `sandboxNavigate` typed the URL into an address bar that did not have focus (Firefox security bar), then returned `ok` whenever the title was not an error page. The claim was never checked against evidence. | The URL now opens through the browser itself. `matchBrowserTarget` requires the window title to carry the expected page's `<title>` (read from the published site). ORVYN start page, new tab, error page or unchanged window → `WRONG_TARGET`. A `desktop.target` event is recorded, and `groundSuccessClaims` rewrites any desktop/Firefox "loaded/showing" claim without a matched target. | `wrongTarget.test.ts` | Fixed (logic), test pending (needs desktop sandbox) |
| 2 | Preview | Preview green "Live Preview" while HTML renders without CSS/images, or blank | **P0** | The pane's status was "a URL exists", not the site's health. Asset causes: root-absolute URLs, CSS `url()` assets never fetched from worker projects, stale inherited bags. | `GET /api/v1/sites/:id/__health` checks the page, every stylesheet, script, image and font, plus CSS `url()`s, returning READY / DEGRADED / FAILED with the exact file. The Preview footer polls it: green only when READY; amber "Preview degraded — styles.css → 404". Serve-time root-URL rebasing and asset fetching landed in 3efaa42/82af4de. | `previewHealth.test.ts`, `hero-mission.mjs` C | Fixed |
| 3 | Preview | Home with no project showed an old project's preview | **P0** | Home was a Workbench view; persisted tab state was app-global | Home is not a Workbench view; no project ⇒ no project panes (other session, d5de927) | workbenchModel test | Fixed |
| 4 | Project | Selector showed "New project" as if it were a project | P1 | Placeholder looked like a name | "No project selected" (d5de927) | unit | Fixed |
| 5 | Mission | Run terminal (execution limit) while ORION still "thinking" + Stop active | **P0** | No terminal-state enforcement on the stream / UI | Per-call timeouts, stream-idle and run-stall watchdogs (70779f2); chat heartbeat + stall end; run watchdog → RUN_STALLED / WORKER_START_FAILED (3efaa42) | `stall-watchdog.mjs` | Fixed; the execution-limit UI state still needs a production re-test |
| 6 | Mission | "Complete" shown while Verify pending/failed | P0 | Stages derived from events loosely | Preview done only on `preview.verified`; Verify only on the verifier's PASS; `run.outcome` partial → "Partial" (82af4de); task-aware Skipped stages (9cb23da) | `missionPhases.test.ts` | Fixed |
| 7 | Desktop | "Desktop is running" while the picture stream timed out | P1 | Session, frame stream and input were shown as one state | Footer reads "Desktop session running · visual stream disconnected" (amber) whenever frames fail | manual/visual | Fixed (UI); a server-side frame-state field is open |
| 8 | Desktop | Browser windows pile up in the sandbox (RAM 80–90 %) | P1 | Every navigation opened a new Firefox window | Navigation opens a tab in the running Firefox | — | Fixed, test pending |
| 9 | Resources | Orphaned desktops, browsers, preview servers or containers after runs | P1 | Not measured yet | — | 10-mission leak test | **Open** |
| 10 | Tools | `write_file({})` "missing: path, content" loop | P0 | The adapter replaced cut-off argument JSON with `{}` | Never fabricate `{}`; flag truncated/invalid; one repair; chunked `append`; 16k output (3efaa42) | `toolArguments.test.ts`, `tool-args-repair.mjs` | Fixed |
| 11 | Tools | The agent bypassed the write guard with `apply_patch` | P0 | Guard covered only `write_file` | Graded guard on every write path; runtime-issued authorization (f486a1c) | editScope tests | Fixed |
| 12 | Capability | False "needs an MCP tool" for project edits | P0 | Chat had no project tools and a search-for-MCP rule | Capability manifest; core vs MCP; chat `start_project_task` (82af4de) | `hero-mission.mjs` D/F | Fixed |
| 13 | Failover | A provider stall mid-mission restarted or stranded the run | P1 | Failover only when nothing had streamed | Retract and fail over with a continuity contract (b65123e, a39a09a) | runtime tests | Fixed; the real-provider test is open |
| 14 | Steering | Composer claimed "queue", not steer | P1 | UI copy | Steer Run is primary; `steer.queued` / `steer.delivered` (a39a09a) | — | Fixed (UI); a real-runtime steering E2E is open |
| 15 | Credits | Header showed 9/1500, 39/4000, 11/1500, 149/1500 | **P0** | Those were a single run's spend over that run's internal budget (the `run.credits` event), shown in the account header whenever the wallet request had not loaded. The wallet was also fetched only once, at startup. | The header shows only the account wallet from the ledger (`GET /billing` → `availableBalance`), as "N credits left", refreshed every 60 s and after every run. The run's spend moves to the tooltip ("This run: …"). | manual; ledger unit tests | Fixed (needs a check on the deployed build) |
| 16 | Workspace | Project lost after restart | P1 | Fixed earlier (`priorLocalWorkerRoot`, `filesOnClient`) | — | `local-followup.mjs`, `session-restore.mjs` | Fixed |
| 17 | Runaway | Multi-million-token missions | P1 | — | Run caps (tokens, model calls, tool calls); loop detection (575485d) | runtime tests | Fixed |
| 18 | State | No single server-owned Project → Workspace → Run → PreviewSession record; the UI infers | P1 | Fragmented ownership (architectural) | Partial: canonical preview target per run (575485d); stable preview id per workspace | — | **Open** — the full `PreviewSession` ownership model is not built |
| 19 | Diagnostics | No impossible-state detector (terminal run + active model, preview green + CSS 404, …) | P2 | — | — | — | **Open** |

## Deployment gates

Every gate must pass before calling ORVYN production-ready.

| Gate | Result |
|---|---|
| G1 Home, no project → no preview/terminal/files | Covered by d5de927 unit test; needs Electron E2E on the packaged build. **Side effect:** since d5de927, a run started while on Home no longer shows its browser session (`browser-session.mjs` fails 9 checks; it passed at a39a09a). The owner of d5de927 must decide how the UI follows a run from Home. |
| G2 Open project → preview styled → close → preview gone (cloud) | Styled preview: `hero-mission.mjs` passes. Close/detach: needs E2E |
| G3 Same, local project | `local-followup.mjs` passes (styled); detach E2E open |
| G4 Project A preview never under B | Open |
| G5 Restart → Home without A's preview; reopen A → preview | Open |
| G6 Stylesheet 404 → Preview DEGRADED, Verify fails | **Pass** (`previewHealth.test.ts`, `hero-mission.mjs` C) |
| G7 Wrong browser target → WRONG_TARGET | **Pass** (logic, `wrongTarget.test.ts`); live desktop run pending |
| G8 Kill frame stream → session running, stream disconnected | UI done; E2E open |
| G9 Low limit → PARTIAL, no thinking, no Stop | Open (execution-limit path) |
| G10 Stream idle → alternate route, same mission | Runtime tests pass; real-provider E2E open |
| G11 Steering during redesign | Open |
| G12 10 missions → no orphans, resources back to baseline | Open |

## Not verifiable from the build sandbox

These need the deployed server or a machine with Docker. They must be run there before release:

- The desktop sandbox (G7 live, G8, G12)
- Real providers (G10)
- The production credit ledger (#15)
- The production preview for site d764c311 (#2 root cause for that exact site)
