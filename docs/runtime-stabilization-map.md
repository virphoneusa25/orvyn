# Runtime stabilization map

Starting SHA for this milestone: `f56e348e5cdf4b15049d9168f026677be259aa09`

This is an audit of the paths that exist in the tree. It is not a certification. The product is not stable until the golden missions pass on an installed `ORVYN.exe`.

## Authoritative path (the one that should exist)

```
submitOrvynCommand
  → POST /agent/stream/runs
  → StreamingAgentRuntime.start
  → prepareRunPreflight
  → provider.stream (tools on)
  → ToolGateway.execute
  → execution provider for the resolved ExecutionTarget
  → RunStore events
  → RunCompletionEvaluator / evaluateCompletionGates
  → truthful terminal status
```

`StreamingAgentRuntime` is the agent loop the composer uses. `ToolGateway` is the tool entry. `RunStore` is the event log the desktop replays.

## Competing paths

| Path | Current caller | Should exist? | Action |
| --- | --- | --- | --- |
| `submitOrvynCommand` → `POST /agent/stream/runs` → `StreamingAgentRuntime` | Composer, chat follow-up, quick actions (`orvynCommand.ts`) | Yes | KEEP. This is the run. |
| `submitOrvynCommand` → WebSocket `/ws/chat` → `Orchestrator.streamChat` | Informational chat classification | Yes, for talk only | KEEP for greetings and questions. Must not run action tasks. |
| `submitOrvynCommand` source `MISSION` → `POST /agent/orchestrate` → `MultiAgentRuntime` | Mission button | No, as a second agent | MIGRATE missions onto `StreamingAgentRuntime`, then disable this loop. It has its own tools, status, and completion. |
| `POST /agent/sessions` → `AgentService` | Legacy session API in `v1.ts` | No | DISABLE. Second status enum (`pending_approval`, `completed`, `error`) and its own tool loop. |
| `publishRememberedSite` / `sitePreview.ts` | `StreamingAgentRuntime.openAgentPreview` on every html/css/js write | No | REPLACE. This copies files into a temp folder and serves them from `/api/v1/sites/:id`. It is not the dev service. CSS written after the first publish used to land on a different URL. |
| `ServiceManager` | Unit tests only. Not called by the runtime. | Yes | WIRE as the only long-running process owner, then delete the static site publisher. |
| `PortForwardingService` | `POST /ports` and the HTTP/WebSocket proxy in `index.ts` | Yes | KEEP as the only cloud preview proxy. One record per service. |
| `RunStore.emitPreviewFromText` | Any `terminal.output` / `tool.completed` that contains a localhost URL when `clientLocal` is true | Only for a service that is actually on the user's machine | KEEP the `clientLocal` guard. Do not add a second publisher. |
| `openSiteOnDesktop` / sandbox Chromium | Removed from the website completion path at `f56e348` | No, for a website | KEEP desktop for `requiresDesktop` tasks only. |
| Blanket refusal of `desktop_*` / `computer.*` whenever `requiresFrontend` | `StreamingAgentRuntime.executeToolCalls` | No | NARROW. Refuse desktop only when the task is a website and `requiresDesktop` is false. A real desktop task must still reach `DesktopSession`. |
| `provider.stream` inside `Orchestrator` | `/ws/chat` | Yes, chat only | KEEP. |
| `provider.stream` inside `StreamingAgentRuntime` | The agent loop | Yes | KEEP. One model loop. |
| `provider.stream` inside `MultiAgentRuntime` | Mission workers | No, once missions move | DELETE with that runtime. |
| Direct `ssh_exec` / `remote_exec` from the model | Tool catalog, gated by preflight | Yes, only after a resolved remote resource | KEEP behind `ToolGateway` and the blocked-run gate. |
| `BrowserSessionService` (Playwright) | Browser tools | Yes, for verification | KEEP. Server-side `fetch` of a preview URL is a health check, not verification. |
| `DesktopSessionService` / `sandboxDesktop.ts` | Desktop tools and `routes/desktop.ts` | Yes, for GUI tasks | KEEP. Do not use it to "show a website". |
| `files.ready` artifact copy plus workspace `file.created` | `openAgentPreview` writes both an artifact and a workspace event | Split by kind | Source files stay on the workspace filesystem. Generated images/documents stay on `ArtifactService`. |

## Run creation and preflight

Authoritative: `routes/v1.ts` `POST /agent/stream/runs` constructs the run, calls `routeExecutionTarget`, then `StreamingAgentRuntime.start`, which calls `prepareRunPreflight` before any tool.

Duplicate: `runPreflight.ts` and `runPreflightResult.ts` both exist. `prepareRunPreflight` in `runPreflightResult.ts` is the one the runtime calls. `runPreflight.ts` is the older helper. Action: one module.

`executionLocation` strings (`OVH_WORKER`, `LOCAL`, `LOCAL_SANDBOX`) and `ExecutionTarget` strings (`ovh_worker`, `local_host`, `local_sandbox`, `remote_resource`) are both still written. The UI reads both. Action: one field, `executionTarget`.

## Status writers

`RunStore.setStatus` is the log. Callers that set it today:

- `StreamingAgentRuntime`: `running`, `blocked`, `error`, `cancelled`, `verifying`, `awaiting_approval`, `completed`
- `MultiAgentRuntime`: its own mission lifecycle on the same store
- `AgentService`: a different in-memory status, not `RunStore`

The desktop header reads run status from events. It also renders assistant prose. A model sentence must not flip the header to completed. `evaluateCompletionGates` is the gate inside `StreamingAgentRuntime` before `setStatus(completed)`. `decideCompletion` in `agentRunState.ts` is a second function with the same job. Action: one evaluator. The model does not set status.

`verifying` and `awaiting_approval` are not in the target status set (`QUEUED`, `RUNNING`, `WAITING_FOR_APPROVAL`, `BLOCKED`, `VERIFYING`, `COMPLETED`, `FAILED`, `CANCELLED`). `error` is used where the target name is `FAILED`. Action: rename at the store, then update the desktop. Do not add a third status field.

## Files, commands, services, preview

- File writes for a run go through `ToolGateway` into the execution provider. `openAgentPreview` then copies the same bytes into `sitePreview` memory and into `ArtifactService`. That copy is the static-preview hack.
- `ServiceManager` can tell a dev server from `npm test`, but nothing in the runtime calls `start`. A finished run therefore never had a service to keep alive. The preview the user saw was the temp HTML publisher.
- `PortForwardingService` can proxy HTTP and WebSocket upgrades. It is not called when a website file is written.
- One preview URL per run is now enforced inside `publishRememberedSite` (`publishedIds`). That only stabilizes the hack. It does not make the preview a service.

## Browser and Desktop

- Workbench Browser: `BrowserWorkbench` plus `window.orvyn.browser`. It should open `preview.available` URLs.
- Workbench Desktop: `DesktopView` polls `/desktop/frame` and starts a sandbox container. `desktop.action` switches the workbench to that tab.
- Website runs were opening Desktop to show a page. That call was removed. A later patch refused every desktop tool on any frontend task. That refusal is too wide and is narrowed in this pass to `requiresFrontend && !requiresDesktop`.
- Verification today is `verifyPublishedPreview`, which `fetch`es the static URL and checks the HTML string. That is not a Browser session, not a screenshot, and not a vision check.

## Conversation and events

- Spoken lines: `conversationCoordinator` via `speak` / `speakProgress`. Evidence-based. This is the chat the user should see.
- Spam: every model turn emitted `thinking` and `agent.phase` with note `Gathering relevant context`. The desktop renders those as Thought rows. Those two emits are removed from `StreamingAgentRuntime` in this pass. `MultiAgentRuntime` still emits `thinking`.
- `conversation.message` and `message.delta` both carry assistant text. One producer should own the user-visible sentence.
- Tool cards are still rendered in the chat from `tool.started`. The target is Activity / Terminal / Changes, not the transcript. Not done.

## What this pass does not claim

Golden missions A–J were not executed on an installed `ORVYN.exe`. CI for the SHA that contains this map was not green at the time the map was written. OVH was last deployed at `f56e348` before these notes.

The static site publisher is still the website preview. Replacing it with `ServiceManager` plus `PortForwardingService` plus a real Browser session is the next structural change. It is not started here, because adding it beside the publisher would be a third preview path.
