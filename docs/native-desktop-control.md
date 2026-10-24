# Native local desktop control (Windows)

ORVYN Desktop 0.2.3 adds a **This computer** surface next to Cloud Desktop. The cloud Linux sandbox remains a separate surface. Local native access is off on every launch; old global host-desktop settings cannot enable it.

## User flow

1. Open Workspace > Desktop > This computer, or Settings > Cloud & Execution > Local desktop permissions.
2. Choose one visible application window. Viewing alone is the default. Optionally allow mouse and keyboard requests.
3. Confirm the native permission dialog. It identifies the executable and window and grants five minutes of access. Screenshots/accessibility details requested by the agent may reach the selected AI provider.
4. A floating control strip stays visible over other apps. **Take Control** cancels pending agent input while preserving permission to view that one window. ORION can inspect the current view to assist while you operate the application yourself.
5. **Return to ORION** requests fresh consent. The agent must obtain a new screenshot before input. Local preview refreshes do not count as an agent observation.
6. **Stop Session**, the floating Stop button, or **Ctrl+Alt+Shift+Escape** revokes both viewing and input. Expiry, application close/navigation, account/backend change, lock/suspend, and helper failure also revoke access.

Preview refreshes stay in the desktop application and do not invoke an AI provider, create a mission, or spend inference credits. Agent assistance uses the existing task/run budget and model routing. There is no unattended inference polling loop.

## Architecture and boundaries

Electron main owns the grant and native dialogs. Renderer IPC accepts only the main frame of the application's main window. The floating strip has a separate sandboxed preload and may only inspect status or revoke input/access; it cannot grant access, capture, or issue commands.

Electron launches a non-elevated C# helper bundled at resources/native/orvyn-native-desktop.exe. The helper has a random session token and communicates only over private stdin/stdout; it has no HTTP listener. It uses UI Automation, PrintWindow, and SendInput. Text is Unicode literal input, never PowerShell/SendKeys syntax. The local engine and signed-in local worker use inherited parent/child IPC. A cloud service cannot enable a local grant. Cloud inference can request native tools only through an explicitly selected local-host worker, with the existing ToolGateway approval checks and the independent local boundary.

Grants bind the exact window handle, PID, process start time, executable and expiry. Every input requires a native allow-once dialog; coordinates are relative to the captured window. Covered points, background input, held modifiers, unsupported keys, oversized requests, changed identities, secure desktops, elevated applications, terminals/security/password-manager processes are rejected. No raw PowerShell desktop-control fallback remains. SYSTEM capabilities stay restricted; LOCAL_DESKTOP only allows requesting the locally guarded tool.

Audit records contain timestamp, action, outcome and PID, never typed text, screenshots or credentials. No file-system, shell, administrator or OS-security consent is implied by this grant. Existing file/terminal permissions are separate.

## Platform and capture limits

Windows x64 is implemented and tested. Windows does not have the same universal Screen Recording/Accessibility consent switches as macOS; ORVYN provides explicit native consent and respects Windows integrity/secure-desktop restrictions without elevation or uiAccess. macOS and Linux native control stay disabled until their adapters and OS permission flows are implemented and verified. Cloud Desktop remains available separately.

PrintWindow captures the selected window without a full-screen fallback. Some protected or GPU-rendered applications may return an unavailable/blank image; this release does not promise every application is capturable. The local surface does not inject Ctrl+Alt+Del, Alt+Tab, or arbitrary system shortcuts. Use your own keyboard during Take Control. Screenshot downloads are local PNGs; this release does not automatically upload them into cloud Generated Files.

## Verification

- Desktop/backend type checks and renderer build.
- Native policy tests cover off-by-default, view-only grants, per-action denial, expiry, forged targets, Stop/takeover during pending approvals (including rejected aborts), bounded input, helper failure, and fresh observations after return.
- Real disposable Windows fixture verifies authenticated helper IPC, scoped PNG capture, accessibility/password redaction, identity/expiry/bounds rejection, and literal Unicode SendInput.
- Isolated Electron acceptance verifies native bridge, floating control strip, takeover retaining viewing, cancellation of a pending input approval, fresh return consent, and full Stop revocation. No user applications are captured or typed into; no paid model calls are made.
- RPC tests preserve screenshot evidence and mount native adapters only for explicit local-host execution. Plan/research cannot acquire native input through Full Access.

Build: npm run dist:win -w @orvyn/desktop. Native fixture acceptance: node scripts/test-native-desktop.mjs --interactive-fixture. The fixture creates its own temporary test window. Headless Windows CI runs helper authentication/expiry checks without interactive input.
