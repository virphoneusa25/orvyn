# ORVYN Desktop releases

Commercial auto-update for **ORVYN Desktop** (Electron). Cloud/backend deploys on OVH are independent. A control-plane change does not require a desktop installer.

**DO NOT COMMIT PRIVATE SIGNING KEYS.** Never add `.pfx`, `.p12`, `.p8`, `.key`, Apple credentials, Windows certificate passwords, R2/AWS secret keys, or GitHub release tokens to git.

## Architecture

1. GitHub Actions builds, signs, and uploads installers to object storage (Cloudflare R2 / S3-compatible).
2. A generic HTTPS feed is served at `https://updates.kernelailabs.com/orvyn/{stable|beta|canary}/`.
3. Packaged ORVYN uses `electron-updater` in the main process (`UpdateService`) to check, download, and install.
4. Control-plane metadata (`GET /api/v1/releases/current`) carries required/minimum version, notes, and rollout pause. It does not host binaries.
5. Admin Portal **Software Releases** edits metadata and rollout. CI remains the authority for binaries. The admin UI cannot upload unsigned executables.
6. Customer portal **Download Desktop** shows public artifact URLs and, when signed in, privacy-safe installation inventory from telemetry.

Startup never waits on the update server. The UI loads first; checks run after a delay with jitter, then about every 4–6 hours, plus a manual Check for Updates.

## Channels

| Channel | Feed |
|---|---|
| stable | `https://updates.kernelailabs.com/orvyn/stable/` |
| beta | `https://updates.kernelailabs.com/orvyn/beta/` |
| canary | `https://updates.kernelailabs.com/orvyn/canary/` |

Override the host only with `ORVYN_UPDATE_BASE_URL` (no localhost in production). Default channel is `stable`, persisted in `orvyn-update-prefs.json`. Downgrades are disabled.

## Versioning

Canonical version: `apps/desktop/package.json` `version` (SemVer). `app.getVersion()` and update manifests must match.

Examples: `1.5.0`, `1.5.0-beta.1`, `1.5.0-canary.12`.

Release tags: `v1.5.0`. `scripts/check-desktop-version.mjs` fails the pipeline if the tag, env, and package.json disagree. Stable must not consume canary versions.

## Update URL structure

Object storage prefix:

```
/orvyn/
  stable/
    latest.yml
    ORVYN-Setup-1.5.0.exe
    …
  beta/
  canary/
```

The private GitHub repository is **not** the customer update feed.

## Windows signing

- Target: NSIS
- Authenticode via electron-builder when `CSC_LINK` / `CSC_KEY_PASSWORD` are set in the **desktop-release-*** GitHub Environment
- Branch CI (`windows-installer`) stays unsigned (`CSC_IDENTITY_AUTO_DISCOVERY=false`, `signAndEditExecutable: false`) so daily artifacts still build

## macOS signing / notarization

- Developer ID + Hardened Runtime (`resources/entitlements.mac.plist`)
- Notarization/stapling via electron-builder when Apple secrets are present
- Targets: `zip` (updater) and `dmg`

## Linux

AppImage initially.

## Required CI secrets (names only)

GitHub Environments: `desktop-release-stable`, `desktop-release-beta`, `desktop-release-canary`. Protect **stable**.

| Name | Purpose |
|---|---|
| `CSC_LINK` | Windows/macOS signing certificate (base64 or file from secrets) |
| `CSC_KEY_PASSWORD` | Certificate password |
| `APPLE_ID` | Notarization Apple ID |
| `APPLE_APP_SPECIFIC_PASSWORD` | Notarization password |
| `APPLE_TEAM_ID` | Apple team |
| `R2_ACCOUNT_ID` | Cloudflare account |
| `R2_ACCESS_KEY_ID` | R2 access key |
| `R2_SECRET_ACCESS_KEY` | R2 secret |
| `R2_BUCKET` | Bucket name (e.g. `orvyn-desktop-updates`) |
| `R2_ENDPOINT` | `https://<accountid>.r2.cloudflarestorage.com` |
| `ORVYN_RELEASE_RECORD_URL` | Optional Admin API to record metadata |
| `ORVYN_RELEASE_RECORD_TOKEN` | Optional staff bearer token for metadata only |

Never print these in logs. Production publishing is skipped when they are absent.

## R2 / S3 setup

1. Create a bucket. **Do not** put credentials in the repo.
2. Point `updates.kernelailabs.com` at a public HTTPS front (Cloudflare custom domain on the bucket, or a CDN). DNS is **not** changed by this codebase.
3. Upload only CI-produced, signed artifacts + `latest.yml` / `latest-mac.yml` / `latest-linux.yml`.
4. electron-updater verifies SHA-512 from the YAML manifest. Invalid or tampered downloads are rejected and not installed.

Signed update manifests: electron-builder 24 / electron-updater 6 use SHA-512 in `latest.yml` plus OS code signatures. Do not silently fall back to unsigned production feeds. Asymmetric publisher keys (`updater.publisherName` / `verifyUpdateCodeSignature` on Windows) should be enabled once Authenticode is live.

## Release procedure

1. Bump `apps/desktop/package.json` version.
2. Tag `vX.Y.Z` on the intended commit (prefer `main` for stable).
3. Run workflow **ORVYN Desktop release** with channel `stable|beta|canary`.
4. Confirm GitHub Environment approval for stable.
5. Confirm objects exist under `/orvyn/<channel>/`.
6. Record/publish metadata in Admin → Software Releases (notes, rollout %).

## Staged rollout

`latest.yml` may include `stagingPercentage` (5, 10, 25, 50, 100). electron-updater uses a local installation id — not MAC/hardware fingerprints. Admin can also set rollout percent; paused releases are not advertised as current.

## Pause / rollback

Pause `1.5.0` in Admin. Installations that have not downloaded it stop receiving it. Do **not** auto-downgrade machines already on 1.5.0. Ship `1.5.1`.

## Required / emergency security update

A super admin sets `required` + `minimumSupportedVersion` on a published release. Clients below the minimum see a blocking update UI. Local project files are not deleted. Cloud missions are paused until the user updates. Ordinary feature releases stay optional.

## Compatibility

Backend/ORION deploys do not bump the desktop version. Use `minimumSupported` only when the native client is actually incompatible.
