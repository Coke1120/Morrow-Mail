# Packaging & in-app updater

## UI

The packaged app boots the first-party renderer shipped in `renderer/` (see [INDEPENDENT_UI.md](INDEPENDENT_UI.md)). `electron-builder` includes that directory via `build.files`. An external `app.asar` is not required.

`MORROW_ASAR` is an optional override that loads an external `app.asar` instead. The app does not look for `resources/ui.asar` on its own. Do not commit an external asar.

## Windows alpha (Leo)

Workflow: `.github/workflows/release.yml` (Actions tab → **release**). It runs on **Run workflow** and on a `v*` tag push. One run publishes Windows and an unsigned macOS zip to the same prerelease. Pull requests stay on the `ci` check job.

1. Bump `package.json` `version` (the first alpha is already `0.1.0-alpha.1`) and merge to `main`. The GitHub tag is `v` plus that version.
2. Actions → **release** → **Run workflow**, branch `main`.
3. The job runs `npm run check`, then unsigned Windows x64:

```bash
CSC_IDENTITY_AUTO_DISCOVERY=false npm run dist:win -- --publish always
```

`dist:win` is `electron-builder --win nsis portable --x64`. `build.win.signAndEditExecutable` is `false`. Authenticode is not configured.

4. The job uploads the NSIS setup exe, its `.blockmap`, the portable exe, and `latest.yml` to a **prerelease** on private `Coke1120/Morrow-Mail`. `latest.yml` is the Windows electron-updater feed and names the NSIS setup. The portable exe is a no-install download. `detectUpdateChannel` is `false`, so `0.1.0-alpha.N` still publishes `latest.yml`.

The feed URL uses dashes (`Morrow-Mail-Setup-0.1.0-alpha.4.exe`). That is the GitHub Release asset name. The copy in `dist/` keeps the spaces in `Morrow Mail Setup 0.1.0-alpha.4.exe`. This rename does not republish `0.1.0-alpha.4`; electron-builder will not replace assets already uploaded for that tag.

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

`build.publish` is GitHub `Coke1120/Morrow-Mail`, `private: true`, `releaseType: prerelease`. The packaged app writes that into `resources/app-update.yml`. With `private: true` and a token in the environment, `electron-updater` uses the GitHub API and reads `latest.yml` (macOS: `latest-mac.yml`) from the newest prerelease.

The installed app needs `GH_TOKEN` or `GITHUB_TOKEN` set to a PAT that can read this private repo (`repo` scope, or contents read). The Actions token that uploads the release is not shipped inside the app. `npm start` leaves the updater off.

A Finder or Start Menu launch does not see a shell export. The same PAT can live in the app userData file `github-update.json` (the folder that holds `settings.json`):

```json
{ "token": "github_pat_..." }
```

Do not commit that file. The environment variable wins when both are set. With no token, the updater does not request `https://github.com/Coke1120/Morrow-Mail/releases.atom` (a private repo returns 404 there) and the shell says how to set the token. A token that cannot read the repo fails with that same explanation instead of an update-available state. `build.publish` stays `provider: github`, `private: true`, `releaseType: prerelease`. The token is passed to `electron-updater` in memory (`setFeedURL`); it is not written into `app-update.yml`.

## Product name, icon, and app id

`productName` is `Morrow Mail`. The macOS bundle display name (`CFBundleDisplayName` and `CFBundleName`) matches. The window title, the application menu, and About use that name.

The app id is `com.coke1120.morrow-mail`. Install Morrow Mail as its own app. This id is not the Swift Morrow Mail id `org.morrowmail.desktop` from [Coke1120/Morrow-Mail](https://github.com/Coke1120/Morrow-Mail).

The GitHub publish repo is `Coke1120/Morrow-Mail`. The npm package name is `morrow-mail`.

Icons are the original Morrow mark (forest green rounded square, pale envelope, rising sun): `build/icon.png` for Linux and as the 1024 source, `build/icon.icns` for macOS, and `build/icon.ico` for Windows. `build/morrow-icon.svg` is that same mark. The rail uses `renderer/morrow-icon.svg`.

Mail, settings, and `ai.json` follow Electron's userData path for Morrow Mail once the app is ready. This build does not copy files from an older application-support folder. Keychain storage is described in [OAUTH.md](OAUTH.md).

## Version

`package.json` version drives the app and the release tag `v${version}`. Stay on `0.1.0-alpha.N`. This rename keeps `0.1.0-alpha.4`.
