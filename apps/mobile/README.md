# ORVYN Mobile

Android and iOS shells reuse the existing Cloud portal in `apps/web`. Account data,
projects, chats, uploaded/generated artifacts, history and billing use the same
cloud APIs as Desktop and Cloud. Local-only Desktop files must be uploaded to the
account before another device can access them. Mobile tasks execute in the cloud
sandbox; no desktop-control permissions are requested on the phone.

## Build

Install the repository's dependencies from its root with `npm ci`, then:

```sh
cd apps/mobile/shell
npm install --workspaces=false
npm run build
npm run add:android
# On macOS with Xcode:
npm run add:ios
npm run sync
npm run open:android
# Or:
npm run open:ios
```

The nested shell has its own dependency installation so ordinary repository
`npm ci` and Desktop/Cloud builds retain their existing lockfile and dependencies.
The recovery workflow generates the shell lockfile and native Android/iOS
projects, checks iOS simulator compilation, and saves them on the recovery branch.
If the native directories are already present, use `sync` instead of repeating
`add`. Android SDK compilation and on-device checks remain separate requirements.

Use Node >=22.13.0 and the Capacitor 8 Android Studio/JDK/SDK and macOS/Xcode
requirements. iOS packaging requires macOS, Apple signing and provisioning.
Android releases require a signing keystore. This scaffold is not a signed
store release.

Set `ORVYN_MOBILE_API_ORIGIN` at build time to the trusted HTTPS origin, for example
`https://staging.orvyn.virphoneusa.com`. It must contain no path, query, credentials
or provider secrets. The default is `https://app.kernelailabs.com`. The native UI
is bundled locally; do not set a remote Capacitor server URL for a release.

## Sign-in and files

Google/GitHub open the system browser. The app claims the existing verifier-bound
one-time handoff, initialized via POST /api/v1/auth/handoff/start before opening the browser; session tokens and the secret verifier never appear in browser
URLs. Return to ORVYN after signing in. Polling stops on cancellation, provider
errors or the ten-minute handoff expiry. Email registration uses the same current
legal acceptance and onboarding requirements as Cloud.

The existing API bearer authentication and single-use WebSocket tickets are used.
SSE progress and image preview links resolve against the configured cloud origin.
Open uses the existing preview pane. Download uses the native save/share sheet.
The account refreshes when the app returns to the foreground; uploads remain
account-owned artifacts. This does not implement automatic arbitrary filesystem
synchronization.

## Verify on a device

1. Sign in by email and separately Google/GitHub on Android and iOS; cancel once.
2. Switch between Desktop, Cloud and Mobile using the same account. Confirm the
   same chat, project and uploaded artifact are present after returning to the app.
3. Send a chat and a tool task. Confirm incremental text and progress, then Stop.
4. Upload an image/file, generate an image, open the preview and save/share it.
5. Check keyboard, attachment chooser, navigation and narrow screens.
6. Run repository tests, web typecheck/build and native SDK builds before release.

The separate mobile Cloud layout fix is intentionally not included in this
reconstruction. This is a reconstruction of unpublished source, not a
byte-for-byte recovery of commit `1f8eb84`.
