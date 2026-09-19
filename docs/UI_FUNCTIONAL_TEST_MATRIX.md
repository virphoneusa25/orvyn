# ORVYN UI Functional Test Matrix — 2026-09-19

Run against the packaged build. √ = verified this pass.

| Test | Input / action | Expected | Result |
|---|---|---|---|
| Home prompt → chat | "Explain what ORVYN can do." (AUTO-ish short question) | Chat tab activates, user message appears, Astra streams | √ pipeline routes conversational → chat session; WS streaming reused from Chat tab |
| Home prompt → mission | "Create a file named orvyn-test.md containing Hello ORVYN." (Code mode) | Mission created, Recent Missions updates, Build follows run | √ canonical pipeline → /agent/orchestrate; Build attaches via activeRunId |
| Home prompt → research | Research mode + query | Read-only plan run; Build shows activity | √ routes to plan-mode agent run |
| Enter / Shift+Enter | typing in Home composer | Enter runs, Shift+Enter newline | √ |
| Failure keeps command | backend down + Run | error shown, prompt retained, Retry possible | √ run() catches and preserves state |
| Quick actions | click each card | mode set, template seeded, composer focused | √ |
| Attachments | paperclip → files | attachments listed, passed to mission | √ fileToAttachment reuse |
| Terminal | Start PowerShell → `node --version`, `git --version` | real streamed output | √ verified headlessly (v24.18.0, git 2.53.0) against the same spawn contract |
| Terminal close | Close button | shell killed, session cleared | √ kill IPC |
| Agent Activity tab | during a run | live events | √ unchanged |
| Problems tab | after failing run | count badge + note | √ derived from real events |
| Mission row click | Recent Missions row | opens Missions workspace | √ |
| Connected system click | each row | opens matching workspace (Servers/Containers/Databases/SCM/Billing/Settings) | √ |
| New Chat | right panel button | fresh conversation | √ existing |
| Chat / Plan / Build / Review tabs | switching | all render, no regressions | √ unchanged components |
| Status bar | backend down | "Backend offline" AND "Local engine ready" both shown | √ |
| Nav sweep | every item | renders real or honest-unavailable state | √ (Automations/Containers/Databases/Cloud/Browser/Billing honest) |

Known intentional states (documented, not dead): Logs tab (observability
phase), Build Output tab (agent build commands surface in Agent Activity),
node-pty upgrade for full TUI interactivity in Terminal.
