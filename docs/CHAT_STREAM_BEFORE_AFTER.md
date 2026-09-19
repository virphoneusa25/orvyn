# ORVYN Chat Stream — Before / After (2026-09-19)

The center conversation rebuild, measured against the spec's target
("USER → ASTRA → compact work indicator → ASTRA result").

## BEFORE — what the attached failure screenshot showed

The Active Workspace rendered the agent engine's internals as the chat:

- giant yellow **REVIEW REJECTED** panel with the reviewer's internal instructions
- internal orchestration lines ("Execute the baseline health-check plan...", "retry 2", "Step started...")
- a **LIVE ACTIVITY** box with raw timestamps (17:46:13 Listing files done…)
- one card per lifecycle event: "Reading file…" → "Reading a file done" ×N
- duplicated plan content, task IDs, mission state mixed into the thread

## AFTER — verified live against a real completed mission (packaged app)

The same pipeline now presents (verbatim rows from the live capture):

- `Inspected workspace · 34 files · 3 searches · 41.7s  ✓`
- `npm run typecheck --workspace…  ●` (while running)
- `Checks · 42 tests passed · 8.1s  ✓`
- `Updated src/index.ts · +1 −0  ✓`

Between rows, Astra's natural narration streams. Review rework is one quiet
line — `↻ Astra requested another pass` — with the full reason on RIGHT → Review.

## How it works (unchanged engine, new presentation)

RAW RUNTIME EVENTS → `presentationReducer` (pure, 10 unit tests) → items:
`assistant`, `WorkGroup` (inspection/checks/edits/browser phases with counts,
durations and +/− totals), `approval`, `status`, `summary`. Consecutive
same-class operations roll into ONE group that updates in place and expands
to per-file/per-command rows; assistant text closes a phase naturally.

- WorkGroups: 34px collapsed, ✓/●/!/✕ states (shape + color + ARIA label),
  keyboard expandable (Space/ArrowDown/Enter), click pins the matching right
  tab (Files/Diff/Terminal/Browser).
- Conversation measure: content capped at 880px, centered.
- No timestamps, no raw event names, no retry counters, no reviewer text, no
  LIVE ACTIVITY box in the center — all of that lives in RIGHT context or the
  dev-only Run Inspector (tree-shaken from production builds).
- Raw events themselves are untouched (durable JSONL log, replay, heartbeats);
  only the presentation changed.

## Test ladder status

- chat (`hi`) → plain Astra reply, no mission UI (smoke suite)
- question/tool/coding/review-rework paths → smoke suite + reducer unit tests
- restart → run history replays and re-reduces to the same clean presentation
  (events are the source of truth; no legacy raw rendering exists)

Raw diagnostics remain available to developers via the Run Inspector.
