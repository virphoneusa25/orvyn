# Desktop updates

The installed Windows `ORVYN.exe` is a packaged Electron build. Pushing commits to git does **not** change that binary.

## How to know which build is running

The status bar shows `Desktop <short-sha>`. That SHA is baked in at package time (`GITHUB_SHA` / `ORVYN_BUILD_SHA` / `git rev-parse HEAD`).

If the status bar SHA does not match the branch HEAD you expected, you are still running an older installer.

## How to get a new UI build today

1. Wait for the `Windows installer artifact` job on `fix/core-agent-runtime`.
2. Download the `orvyn-windows-<short-sha>` artifact from that GitHub Actions run.
3. Close every `ORVYN.exe` / Electron process.
4. Install the new `ORVYN Setup *.exe`.
5. Launch and confirm the status-bar SHA.

User data (chats, safeStorage session, workspace prefs) should survive an upgrade-in-place. Do not wipe `%APPDATA%` just to update the executable.

## Future

ORVYN still needs a signed auto-update / release channel (electron-updater or equivalent). That is not shipped in this milestone. The status-bar SHA is the source of truth until then.
