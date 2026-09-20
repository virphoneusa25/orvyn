# ORVYN Core Agent Vertical Slice — Audit (Phase 0, 2026-09-19)

Traced user instruction → run → model → tool → filesystem → event → UI →
click → right panel. What follows is the honest state, verified against code
and live runs from today's sessions.

## The vertical slice as it stands

| Link | Status | Notes |
|---|---|---|
| Conversation → Run | ✅ | canonical `submitOrvynCommand`; intent classification; per-run identity (title leak fixed in b6439e8) |
| Run → Model | ✅ | ModelGateway role→task routing; per-call timeouts (f76126e); English enforcement (293db22) |
| Model → Tool call | ✅ | full loop, parallel-safe, tool schemas from ToolGateway registry |
| Tool → Filesystem | ✅ real | fileTools operate on the real project root; Windows terminal normalization (8c9be90) |
| Execution → Events | ✅ | typed events, monotonic sequence, durable JSONL replay (f76126e) |
| Events → Center stream | ✅ | presentationReducer → WorkGroups/rows; chronological by sequence; no raw events |
| **Row click → right panel exact file** | ❌ **BROKEN** | clicks only pin the TAB (orvyn:context-tab); they do not open the specific file/diff |
| **File-type icons** | ⚠️ partial | colored TEXT badges (TS/JSON), not the icon system the spec requires; no registry, no fallback contract |
| **Workspace authority** | ❌ | no WorkspaceSession; when no folder is open, a hidden built-in AppData workspace is used silently — caused the "health-check can't find the project" failures |
| File artifacts | ⚠️ partial | editPreview events carry real diffs/±counts, but file tool RESULTS are prose ("file edited successfully"); no structured FileArtifact the UI/model share |
| Project tree ↔ agent | ⚠️ | both use the same root, but no filesystem watcher — tree does not update after agent edits without refresh |
| Model selector | ⚠️ | composer picker writes real routing overrides (capability-validated, persisted, honored); NOT yet per-run requested/actual recording |
| Stop | ✅ | aborts provider, denies approvals, CANCELLED, partial output kept (spec Part V satisfied) |
| Permission modes | ✅ | real autonomy profiles drive the Permission Engine (applyMode/PROFILES) |
| Duplicate state / leaks | ✅ fixed | single chatSession + single agentRun in App; run-scoped events; stale-title bug eliminated |

## Architectural gaps to repair (this phase)

1. **ONE context-open controller**: every file-ish row (Read/Edit/Create in
   WorkGroups and tool rows) currently dispatches a tab-pin only. Fix: a
   single `openArtifactInContext({ tab, file, op })` path that carries the
   FILE, and a ContextPanel handler that opens the exact file in Files
   (real contents) or its real diff in Diff.
2. **FileTypeRegistry**: one extension→language→icon map, local SVG
   components, generic-file fallback, unit-tested for full coverage.
3. **No fake workspace**: submitting an execution request with only the
   built-in workspace must surface "I need a project workspace" + Open
   Project instead of silently working in AppData.
4. **Structured file results**: file tools return op/path/± counts as
   structured text the model can rely on (events already carry previews).

## Dead/fake implementations found

- None remaining that we can find: earlier fake indicators were removed in
  previous phases; Live Activity box eliminated (86b5821); missions, tools,
  terminal, git, browser are all real executions. The remaining "prototype
  seam" is the click-through above.
