# Tool Gateway

The single path for every side effect an agent performs. Agents receive
tool *names*; execution goes through `ToolGateway.execute(name, args, role)`
which enforces, in order:

1. **User policy** per tool: `allowed | ask | denied`. `ask` pauses the run
   (`approval.required` event) until the user resolves it: **Allow Once**,
   **Allow for Mission** (that tool is auto-approved for the rest of the
   run; cleared when the run ends; never offered for destructive commands),
   or **Deny**.
2. **Capability check**: the calling role must hold every capability the
   tool requires (Permission Engine). A denied capability is a typed error,
   not a silent skip.
3. **Sandbox**: file/terminal/git tools resolve paths inside the project
   root only (`resolveSafe`); path escapes are rejected.

## Registered tools (35)

| Group | Tools | Capability |
|---|---|---|
| Filesystem | read_file, list_directory, write_file, edit_file, move_file, delete_file | READ / WRITE / DELETE |
| Search | search_files (names), search_code (ripgrep with fallback), list_symbols (regex v1) | READ |
| Execution | terminal (alias run_command), start_process, stop_process, read_process_logs, list_processes | EXECUTE |
| Verification | get_diagnostics, run_typecheck, run_tests, run_linter | READ/EXECUTE |
| Git | git_status, git_diff, git_log, git_branch, git_checkout, git_commit | GIT (+WRITE for mutations) |
| Network | fetch_url (private-IP blocked), web_search | NETWORK |
| Browser QA | browser_open, browser_navigate, browser_click, browser_type, browser_screenshot, browser_console_errors | NETWORK/EXECUTE — Playwright launches bundled Chromium, falling back to system Chrome/Edge; typed error if none is available |
| Media | generate_image | NETWORK |
| MCP | mcp_list, mcp_call | NETWORK |

Default policy: reads are `allowed`; writes, deletes, execution, network,
and git mutations are `ask`. The user can change any tool's policy in the
Tools UI (`POST /api/v1/tools/:name/permission`); overrides survive
re-registration for the same project root.

## Autonomy profiles (spec §47)

The user picks a profile in Settings (`GET`/`POST /api/v1/profile`):

| Profile | Effect |
| --- | --- |
| SAFE (default) | mode defaults untouched — every risky action asks |
| BALANCED | pre-approves normal coding ops: write_file, edit_file, move_file, run_tests, run_typecheck, run_linter |
| AUTONOMOUS | additionally pre-approves terminal, processes, network, git checkout/commit, browser tools |

Composition order: mode permissions → profile upgrades (`ask`→`allowed`
only, never relaxing a mode's `denied`) → explicit per-tool user overrides.
Hard boundaries no profile can remove: destructive shell commands always
require approval, `mcp_call` always asks, the project-root sandbox, and
role capability checks.

## Pending interfaces (declared, not faked)

`find_references` (needs LSP), DATABASE and DEPLOYMENT tools — the
capability flags exist and are denied for every role until real tools ship.

## MCP

External MCP servers are configured per project in `.orvyn/mcp.json`. Only
`McpHub` speaks the protocol; agents see generic `mcp_list` / `mcp_call`
tools that pass through the same permission checks as everything else. An
MCP server can never bypass ORVYN authorization.

## Adding a tool

1. Implement `AITool` (name, description, JSON-schema parameters,
   `execute`) under `apps/backend/src/ai/tools/`.
2. Map its capability in `gateway/PermissionEngine.ts`.
3. Register it in `ai/registerProjectTools.ts`.
4. Grant the capability to the roles that should reach it.
