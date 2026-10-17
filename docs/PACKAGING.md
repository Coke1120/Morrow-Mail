# Packaging & in-app updater

## UI

The packaged app boots the first-party renderer shipped in `renderer/` (see [INDEPENDENT_UI.md](INDEPENDENT_UI.md)). `electron-builder` includes that directory via `build.files`. A Genspark `app.asar` is not required.

`GENMAIL_ASAR` is an optional override that loads an external `app.asar` instead. The app does not look for Genspark Super App or `resources/ui.asar` on its own. Do not commit an external asar.

## Windows alpha (Leo)

Workflow: `.github/workflows/release.yml` (Actions tab → **release**). It runs on **Run workflow** and on a `v*` tag push. One run publishes Windows and an unsigned macOS zip to the same prerelease. Pull requests stay on the `ci` check job.

1. Bump `package.json` `version` (the first alpha is already `0.1.0-alpha.1`) and merge to `main`. The GitHub tag is `v` plus that version.
2. Actions → **release** → **Run workflow**, branch `main`.
3. The job runs `npm run check`, then unsigned Windows x64:

```bash
CSC_IDENTITY_AUTO_DISCOVERY=false npm run dist:win -- --publish always
```

`dist:win` is `electron-builder --win nsis portable --x64`. `build.win.signAndEditExecutable` is `false`. Authenticode is not configured.

4. The job uploads the NSIS setup exe, its `.blockmap`, the portable exe, and `latest.yml` to a **prerelease** on private `Coke1120/genmail-rea`. `latest.yml` is the Windows electron-updater feed and names the NSIS setup. The portable exe is a no-install download. `detectUpdateChannel` is `false`, so `0.1.0-alpha.N` still publishes `latest.yml`.

The feed URL uses dashes (`GenMail-REA-Setup-0.1.0-alpha.1.exe`). That is the GitHub Release asset name. The copy in `dist/` keeps the spaces in `GenMail REA Setup 0.1.0-alpha.1.exe`.

Run the workflow from `main`. electron-builder creates the release tag from the repo default branch when the tag does not already exist.

Optional tag: push `v0.1.0-alpha.N` only when it matches `package.json` `version`. A mismatch fails the job before publish.

Same unsigned build on a dev machine, without uploading:

```bash
npm ci
CSC_IDENTITY_AUTO_DISCOVERY=false npm run dist:win
```

Artifacts land in `dist/` (`latest.yml`, `*Setup*.exe`, `*.exe.blockmap`, portable exe).

On Linux, the NSIS uninstaller step needs Wine, including `wine32:i386`. The release job runs on `windows-latest` and does not use Wine.

electron-builder attaches files to an existing release only for about two hours after publish. The next alpha needs a new `version`. Re-running the same version later skips the upload.

## macOS

The same **release** workflow runs on `macos-latest` after the Windows job, and publishes an unsigned zip plus `latest-mac.yml` (and a blockmap when electron-builder writes one) to that prerelease. Windows creates the prerelease first. `build.mac.identity` is `null`. The job sets `CSC_IDENTITY_AUTO_DISCOVERY=false` and does not codesign or notarize. The zip arch is the runner's (Apple silicon on `macos-latest`).

```bash
CSC_IDENTITY_AUTO_DISCOVERY=false npm run dist:mac -- --publish always
```

Apple codesign and notarization stay on the MBA, locally, for a later step. Unsigned zip only, no upload:

```bash
CSC_IDENTITY_AUTO_DISCOVERY=false npm run dist:mac
```

## Updater reads (private repo)

`build.publish` is GitHub `Coke1120/genmail-rea`, `private: true`, `releaseType: prerelease`. The packaged app writes that into `resources/app-update.yml`. With `private: true` and a token in the environment, `electron-updater` uses the GitHub API and reads `latest.yml` (macOS: `latest-mac.yml`) from the newest prerelease.

The installed app needs `GH_TOKEN` or `GITHUB_TOKEN` set to a PAT that can read this private repo (`repo` scope, or contents read). The Actions token that uploads the release is not shipped inside the app. `npm start` leaves the updater off.

A Finder or Start Menu launch does not see a shell export. The same PAT can live in the app userData file `github-update.json` (the folder that holds `settings.json`):

```json
{ "token": "github_pat_..." }
```

Do not commit that file. The environment variable wins when both are set. With no token, the updater does not request `https://github.com/Coke1120/genmail-rea/releases.atom` (a private repo returns 404 there) and the shell says how to set the token. A token that cannot read the repo fails with that same explanation instead of an update-available state. `build.publish` stays `provider: github`, `private: true`, `releaseType: prerelease`. The token is passed to `electron-updater` in memory (`setFeedURL`); it is not written into `app-update.yml`.

## Version

`package.json` version drives the app and the release tag `v${version}`. Prefer `0.1.0-alpha.N` until rebrand.
