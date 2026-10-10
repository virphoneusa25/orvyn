# Cloud workspace resizing, changes, and capability verification

The split divider supports pointer dragging, Left/Right (Shift for larger steps), Home/End, and double-click to reset. The saved ratio is bounded by the current container; mobile keeps the existing Chat/Workspace switch. Expand and collapse preserve the draft.

Changes are derived from durable tool/file events, never assistant narration. Pending edits are separate from completed counts; failed/cancelled attempts do not become successful changes. Create-file and patch aliases emit the same domain events as writes. Rename opens its destination. The displayed diff is the latest verified operation for each file, not a Git baseline of the entire project. Shell-only changes without file events are not invented as diffs.

Website viewing/review requests (including the customer's "can you veiw sinch.com and tell me what it is?") use the browser agent path across Cloud and Desktop. Successful navigation plus screenshot evidence is required by existing completion gates. Captured browser frames are stored as run artifacts and replayable after a fast run or reopening; they are labelled as the last frame, not a live browser. Cloud replay is tenant/run-bound and never enables input after completion.

Capabilities remain scoped to the run, role, mode, workspace, and approvals. MCP discovery remains available for generic tasks. Discovered native/installed tools and selected skill dependencies gain schemas without bypassing permission checks. Cloud create_file/apply_patch aliases use the worker write contract, with before/after read-back and the existing write guard; move_file is routed to the worker instead of touching control-plane files.

Validation uses the real runtime/gateway/registry, a real SDK MCP child-process roundtrip, worker RPC adapter contracts, skill routing suites, and the pinned sandbox's actual Chromium. Model replies and browser UI API responses are scripted fixtures. These checks do not prove credentials/connectivity for every customer MCP, SSH host, SaaS API, or paid provider. Missing auth, unavailable resources and denials must remain explicit failures.

Manual acceptance:
1. On Cloud desktop width, drag the divider left/right; check chat/composer remain usable. Reload and check saved width. Home/End, arrow keys and double-click work. On mobile, no divider or stacked workspace.
2. Ask "can you view sinch.com and tell me what it is?" in AUTO. The request creates an agent run, uses browser_open and browser_screenshot, and the right pane shows its browser. Allow requested approvals. If denied/unreachable, it reports failure instead of claiming inspection.
3. Complete/reopen a browser run. The stored real screenshot displays with finished/read-only status; takeover stays disabled.
4. Create a text file, edit it, rename it, then delete it. Changes show the verified operations/diffs, with destination Open for rename. Trigger an invalid edit: it must not increase completed change count.
5. Configure an authorized MCP; request its action. Discovery activates the registered tool schema and actual output returns to the agent. Invalid/missing credentials remain failures. Test selected skills using their installed dependencies.
