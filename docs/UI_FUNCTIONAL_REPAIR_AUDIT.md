# ORVYN UI Functional Repair Audit — 2026-09-19

Audited before repair. Status legend: WORKING / PARTIAL / BROKEN / SIMULATED / NOT-IMPLEMENTED.

| Component | File → handler → service | Expected | Actual at audit | Status |
|---|---|---|---|---|
| Home composer Run | `Home.tsx` → inline fetch → `/agent/orchestrate` or `/agent/stream/runs` | Starts real work; UI follows it | Starts real work, but Build tab never attaches → work invisible | PARTIAL |
| Home → Chat | none | conversational input lands in Chat tab | no path — chat only from right panel | BROKEN |
| Enter key | `Home.tsx` keydown | Enter=Run, Shift+Enter newline | Ctrl+Enter required | PARTIAL |
| Quick actions | `Home.tsx` applyQuickAction | configure composer | works (mode+template) | WORKING |
| Chat tab | `AIChatPanel` → WS `/ws/chat` + chatSession store | streaming, history, markdown | works | WORKING |
| Plan tab | `ComposerPanel` → `/composer/plan` | real plan | works | WORKING |
| Build tab | `AgentEventStream` → `useAgentRun` → SSE | shows active run/mission | works ONLY for runs it started itself — Home/mission runs never attach | PARTIAL |
| Mission Plan card | `MissionPlan.tsx` ← run events | live steps | fed by events, but starved (same attach gap) | PARTIAL |
| Live Activity | `MissionPlan.tsx` ← run events | live feed | same gap | PARTIAL |
| Review tab | `ReviewPanel` → `/missions` + run events | verdicts | works for missions | WORKING |
| Bottom Terminal tab | `BottomWorkPanel` | real shell | "no shell session" — node-pty never installed (honest msg, but terminal missing) | NOT-IMPLEMENTED |
| Agent Activity tab | `BottomWorkPanel` → run events | live feed | works | WORKING |
| Connected Systems | `Home.tsx` | recognizable icons, clickable | generic icons, not clickable | PARTIAL |
| Recent Missions rows | `Home.tsx` → `/missions` | click opens mission | not clickable | PARTIAL |
| StatusBar | `StatusBar.tsx` | local-vs-cloud clarity | "Backend offline" conflates local engine | PARTIAL |
| Nav items | `Navigation.tsx` → views | all destinations render | all wired (honest states for unbuilt) | WORKING |

## Repair plan executed this pass

1. **Canonical command pipeline** (`orvynCommand.ts`): one `submitOrvynCommand()`
   used by Home + quick actions — classifies conversational vs executable,
   routes to chat / mission / plan-run; Enter=Run.
2. **Home → right panel follow-through**: App tracks the active run id; Build
   (and its Mission Plan + Live Activity) attach to whatever run is active,
   wherever it was started.
3. **Real terminal**: main-process PowerShell via child_process pipes with
   streaming IPC (input works, output streams, commands are real). node-pty
   remains the upgrade path for full interactive TUI apps — documented, not
   hidden.
4. **Integration icons** (`IntegrationIcon`): recognizable marks (GitHub,
   Docker, PostgreSQL, Stripe, OVH, server, ORVYN) + clickable system rows
   and mission rows.
5. **Status bar**: "Local · Ready" vs cloud reachability stated separately.
