# Workspace agent acceptance

Fresh ORVYN conversation on branch `fix/core-agent-runtime`. The prompt was sent with no client `projectRoot`, `composerMode: agent`, `permissionMode: full_access`, and `executionTarget: auto`.

Prompt:

> Build a simple website for VirPhone USA. Research the current VirPhone site and relevant wholesale VoIP presentation patterns, then build the site in this workspace and verify it.

The run used the backend that holds the website final until verification finishes, lists the real service command in the terminal model, and does not rewrite a verified site answer into “No file was saved” when the reply mentions download cards.

Electron was not opened. Workbench rows below are the same renderer model the desktop uses (`projectWorkbench` and `reconcileWorkbenchTabs`) applied to the live events and to the session restored after the backend process was stopped and started again.

## Run

| Field | Value |
| --- | --- |
| runId | `16bbfe46-2659-4bb6-b1af-68a3326f6f17` |
| sessionId | `sess_7d42f500759acc37` |
| projectId | `proj_10fe3ecfb5a93260` |
| workspaceId | `ws_16e49dbbc6d523f9` |
| projectRoot | `/tmp/orvyn-ws-accept-3/data/tenants/default/workspaces/ws_16e49dbbc6d523f9` |
| execution | LOCAL / `local_host` |
| model | `fw:accounts/fireworks/models/kimi-k2p7-code` returned 404, then the run continued on `fw:accounts/fireworks/models/glm-5p3` (`model.unavailable`). That switch is not a tool-failure escalation. |
| preview URL | `http://127.0.0.1:4693/api/v1/sites/f73aa9b0-506d-4615-9462-f4f5731df0dd/` |
| browser URL | `http://localhost:8000/` |

`workspace.resolved` was emitted once: `created: true`, `restored: false`. `run.session` carries the same session, project, and workspace ids. The root did not change during the run.

## Tools called

Agent tools (not the verifier):

- `web_search` (2, both completed)
- `fetch_url` (2, both completed, HTTP 200 for virphoneusa.com and a wholesale VoIP page)
- `list_directory` (1, completed)
- `write_file` (index.html and styles.css completed; one earlier call failed)
- `edit_file` (styles.css, completed)
- `start_process` (`python3 -m http.server 8000 --bind 0.0.0.0`, completed)
- `read_process_logs` (completed)
- `terminal` (3, completed: HTTP checks, then two screenshot `file` checks)
- `browser_open` (`http://localhost:8000/`, completed)
- `browser_screenshot` (4, completed)
- `browser_console_errors`, `browser_evidence` (completed)
- `browser_set_viewport` (390×844 and 1280×800, completed)
- `browser_click` (burger and FAQ, completed)

Verifier tools after `verification.started`: `list_directory`, `read_file` (2), `search_code` (9).

## Tool failures

| Sequence | Tool | Where | Error |
| --- | --- | --- | --- |
| 242 | `write_file` | agent | `INVALID_ARGUMENTS`: missing required arguments `path` and `content` |
| 797, 799, 805 | `search_code` | verifier | `spawn ENOTDIR` |

The invalid `write_file` was followed by calls that included `path` and `content` (`index.html`, 21723 characters; `styles.css`, 19822 characters). `file.created` followed for both files. There was no `route.escalated` and no `model.escalated`. The phrase “I need to actually supply path/content this time” does not appear.

The verifier `search_code` failures did not change the verdict. `verification.completed` is PASS.

## Files created

On the workspace root:

- `index.html` (write)
- `styles.css` (write, then one edit)

Session state after restart records `index.html` as `write` and `styles.css` as `edit`, both on this runId. Download-card artifact names are `index-2.html` and `styles-2.css`. The workspace files are `index.html` and `styles.css`.

Screenshots under `.orvyn/screenshots/`:

- `shot_1790473591275.png` — PNG 1280×800, VirPhone USA hero (Global Voice & Telecom Infrastructure, Get a Quote, 844-684-9222)
- `shot_1790473611628.png` — PNG 390×844
- `shot_1790473613018.png` — PNG 390×844
- `shot_1790473623738.png` — PNG 1280×6540

## Verification evidence

`verification.completed` sequence 816, verdict PASS. Checks:

- changed files exist — pass (2/2 readable)
- page references resolve — pass
- scripts and styles parse — pass
- tests and builds — skip (none run)
- browser — pass (11 observations after the last change, 0 console errors, 0 network errors)

`browser.completed` for `browser_open` and four `browser_screenshot` calls at `http://localhost:8000/`. `curl` against that server returned HTTP 200 for `index.html` (21727 bytes) and `styles.css` (19773 bytes). The published preview returned HTTP 200 before and after the backend restart.

The streamed “site is complete” answer was retracted with reason `final answer waits for verification` and published again at sequences 818–819, after `verification.completed`. The kept final does not say “No file was saved.”

## Workbench tabs

Live surface from the run events:

- status `created`, label “New workspace”
- list root is the provisioned `projectRoot`
- a guessed `/opt/orvyn/workspaces` root is not listed
- Files: `index.html`, `styles.css`
- Changes: both created
- Terminal commands include `python3 -m http.server 8000 --bind 0.0.0.0` and the `curl` HTTP check. There is no placeholder row named `command`.
- Browser URL `http://localhost:8000/`
- Preview URL is the sites URL above

Reconciled tab ids (changes, files, terminal, generic browser, `browser:tab1`, preview URL, `file:./index.html`, `file:index.html`, plus the native browser tab):

- `changes`
- `files`
- `terminal`
- `browser:tab1`
- `file:index.html`
- `preview:http://127.0.0.1:4693/api/v1/sites/f73aa9b0-506d-4615-9462-f4f5731df0dd`

Ids are unique. The generic `browser` tab is not kept beside `browser:tab1`. The localhost browser URL and the published preview URL are different surfaces, so both remain.

Reopen with an empty event list and the restored session snapshot: `sameWorkspace` is true, files are `index.html` and `styles.css`, and the preview URL is unchanged.

## Explicit fail conditions

| Condition | Result |
| --- | --- |
| ORION says “the project folder is empty” for an existing or restored workspace | Not said. A retracted tool-turn line on the newly created workspace said “Workspace is empty as expected.” |
| ORION says “I need to actually supply path/content this time” more than once | Count 0 |
| Repeated malformed tool calls escalate the model before structured repair | One malformed `write_file`, then a valid write. No `model.escalated` or `route.escalated`. |
| Workbench shows a different workspace than the run | List root is `ws_16e49dbbc6d523f9`, the same id as the run. |

## Acceptance items

| # | Requirement | Result |
| --- | --- | --- |
| 1 | A WorkSession exists | PASS. `sess_7d42f500759acc37` |
| 2 | A real workspace is resolved/provisioned | PASS. `workspace.resolved` with `ws_16e49dbbc6d523f9` and an absolute project root |
| 3 | The workspace identity does not change during the run | PASS. One resolve event; session, project, workspace, and root stay the same |
| 4 | Research tools work | PASS. `web_search` and `fetch_url` completed |
| 5 | File tools receive valid path/content arguments | PASS. `index.html` and `styles.css` were written with both arguments |
| 6 | A malformed call, if one occurs, is repaired without unnecessary model escalation | PASS. One `INVALID_ARGUMENTS`, then a valid write, no escalation |
| 7 | `index.html` and supporting files are actually created | PASS. `index.html` and `styles.css` are on disk |
| 8 | Browser/preview is started | PASS. Site preview published and `python3 -m http.server 8000` running |
| 9 | Shared Browser opens the page | PASS. `browser_open` completed at `http://localhost:8000/` |
| 10 | Visual verification occurs | PASS. Screenshots plus browser check PASS |
| 11 | Right Workbench shows the correct files, terminal/service, and Browser | PASS. Files, the http.server command, browser URL, and preview URL match this workspace |
| 12 | Tab bar has no duplicates | PASS. Six unique tab ids; no generic browser beside `browser:tab1` |
| 13 | ORION does not repeatedly narrate future actions without performing them | PASS. Tool-turn narration was retracted and each step ran a tool |
| 14 | Final response occurs only after verification | PASS. Visible final starts at sequence 818; `verification.completed` is 816 |
| 15 | Closing/reopening ORVYN restores the same conversation and workspace | PASS. Backend restarted on the same data dir. Session state returns the same session, project, workspace, root, runId, both files, and the same preview. Reopen projection matches that identity. |

Overall: PASS.
