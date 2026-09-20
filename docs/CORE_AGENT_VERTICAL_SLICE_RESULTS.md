# Core Agent Vertical Slice — Phase 0 Results (2026-09-19)

Audit: see CORE_AGENT_VERTICAL_SLICE_AUDIT.md. Repairs below were verified in
the real Electron app (clicks driven against the live UI), not only by unit
tests.

| Feature | Expected | Actual | Pass/FAIL | Evidence |
|---|---|---|---|---|
| File-type icons | local SVG per extension, fallback, no remote/emoji | fileTypeRegistry (40+ extensions → language+color, unit-tested) drives the row glyphs | PASS | live capture: colored doc glyphs on every file row; 4/4 registry tests |
| Read row click | opens RIGHT → Files with THAT file's real contents | clicked "Read package.json" → Files tab active, package.json chip selected, real JSON shown (`{ "name": "orvyn", …`), Open in Code present | PASS | live UI click, captured |
| Edit row click | opens RIGHT → Diff with THAT file's real diff | clicked the Edited row → Diff tab active, apps/desktop/package.json first with +1 −1 and green add lines | PASS | live UI click, captured |
| One context controller | single open path, no per-component handlers | `contextOpen.ts` — every row goes through `openArtifactInContext()`; ContextPanel is the sole listener | PASS | code; typecheck |
| No fake workspace | execution refused against the hidden built-in workspace with guidance | `isBuiltInWorkspace()` guard in submitOrvynCommand returns "I need a project workspace… Open a project folder" | PASS | code + typecheck (behavior change from the failing health-check scenario) |
| Structured file results | op + path + counts, not prose | write → `CREATED/OVERWROTE path (N lines)`; edit → `EDITED path — N replacements (+X lines)` | PASS | backend typecheck + suite |
| Already-true slice links | streaming, tool loop, ordering, Stop, English, terminal normalization | unchanged, previously verified | PASS | prior phases' evidence; suite 70/71 |

## Tests executed
- Full suite: 71 tests, 70 pass, 0 fail (1 pre-existing skip) — includes the
  new fileTypeRegistry coverage test (all spec-required extensions).
- Renderer + backend typecheck clean; desktop build clean.

## Files changed (this phase)
- `apps/desktop/src/renderer/fileTypeRegistry.ts` (+test) — one icon/language authority
- `apps/desktop/src/renderer/contextOpen.ts` — the single artifact-open controller
- `components/ToolActivityRow.tsx` — registry-backed icons; Open ↗ carries the exact file
- `components/ContextPanel.tsx` — `orvyn:context-open` listener; Files/Diff focus the clicked file (diff floats to top)
- `orvynCommand.ts` — built-in-workspace refusal with Open Project guidance
- `backend/src/ai/tools/fileTools.ts` — structured write/edit results

## Known issues / not in this phase
- Filesystem watcher for the project tree (Part Z) — tree refreshes on
  navigation, no live watcher yet.
- Per-run requested/actual model recording (Part T) — the routing override
  path is real and honored; per-run recording remains future work.
- Monaco in the right Files viewer — currently a styled pre viewer with real
  contents; Monaco upgrade pending (editor chrome already uses Monaco).
