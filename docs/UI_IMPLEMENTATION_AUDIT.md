# ORVYN UI Implementation Audit

> Against the approved desktop mockup (2026-09-19). Governs the AppShell/Home
> rebuild. Rule: preserve all working functionality; every new surface shows
> real state or a truthful unavailable state — never demo data.

## Existing components → disposition

| Existing | Mockup counterpart | Disposition |
|---|---|---|
| `TitleBar.tsx` (custom chrome, menus, window controls) | Top bar | **Reuse + extend**: keep menus/win-controls/drag; add subtitle, centered command/search (opens existing CommandPalette), right-side real usage chip |
| `ActivityBar.tsx` (48px icon rail) | Labeled sectioned nav (~190px) | **Replace** with new `Navigation.tsx`; old views remap (Explorer→Code, Agents & Missions→Missions, AI Models→Models, Reports→Usage & Credits) |
| `App.tsx` view switch | AppShell | **Restructure**: Home default landing; right AI panel persists over Home + Code; StatusBar added; Code view internals untouched |
| Monaco editor, EditorTabs, FileExplorer, InlineEdit, tab-complete | Code workspace | **Unchanged** (opens as the Code nav item) |
| `AIChatPanel` / `ComposerPanel` / `AgentPanel(AgentEventStream)` / `ReviewPanel` | Right panel Chat/Plan/Build/Review | **Unchanged**; Build gains Mission Plan card + Live Activity (both derived from real run events) |
| `AgentActivityList` (tool cards, approvals, diffs, RunFooter) | Build tab activity | **Unchanged** |
| `BottomPanel` (Agent Activity) | Terminal/Activity area | **Kept**; real interactive Terminal needs node-pty → documented gap, no fake shell |
| `MissionControl.tsx` | Missions workspace | **Reused** as the Missions nav item |
| `ModelManager.tsx` | Models workspace | **Reused** |
| `ConnectionSettings.tsx` | Settings | **Reused** |
| `ChatHistoryPanel` / `ReportsPanel` | — | Reachable via palette/Usage item; kept |
| `CommandPalette` | Ctrl+K command bar | **Reused**; binding stays Ctrl+Shift+P (Ctrl+K is inline edit — not sacrificed) |

## New components

- `Navigation.tsx` — sections: primary (Home/New Task/Missions/Automations),
  WORK (Projects/Code/Terminal/Browser), INFRASTRUCTURE
  (Servers/Containers/Databases/Cloud), AI (Agents/Models/Tools & MCP),
  ACCOUNT (Usage & Credits/Billing/Settings).
- `Home.tsx` — hero + task composer (starts REAL missions via
  /agent/orchestrate), quick actions (prefill modes), Recent Missions
  (live /missions + /agent/stream/runs), Connected Systems (real backend
  ping + ssh.json servers + truthful "Not connected" rows).
- `MissionPlan.tsx`, `LiveActivity.tsx` — real event-derived.
- `StatusBar.tsx` — real backend health/version, running runs, active missions.
- `ServersWorkspace.tsx` (real ssh.json list + on-demand real health check via
  the approved tool-execution route), `ToolsWorkspace.tsx` (real /tools),
  `AgentsWorkspace.tsx` (real /agents roster).
- `HonestState.tsx` — shared truthful "not available yet + why + what enables
  it" surface for Automations/Containers/Databases/Cloud/Browser/Billing.

## Backend additions

- `GET /api/v1/servers` — aliases from `.orvyn/ssh.json` (no key material).

## Gaps documented, not faked

Interactive Terminal (needs node-pty), Containers/Databases/Cloud live views
(need the corresponding tools/workers), Automations scheduler, Billing
(commercial Phase D–E), CPU/RAM status metrics (no IPC source — omitted
rather than shown fake).

## Order

tokens → icons → Navigation → TitleBar → StatusBar → Home(+ /servers) →
MissionPlan/LiveActivity → workspaces → App rewire → build/package →
visual pass against the mockup.
