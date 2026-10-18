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

`dist:win` is `electron-builder --win nsis portable --x64`. `build.win.signAndEditExecutable` is `false`. Authenticode is not configured. SignPath Foundation signing is pending approval and is not in this workflow. See [Code signing policy](../CODE_SIGNING_POLICY.md) and [SIGNPATH.md](SIGNPATH.md).

That flag also skips electron-builder's own resource edit, which would leave the installed `Morrow Mail.exe` as Electron's icon and product name. `build.afterPack` (`scripts/windows-icon.js`) writes `build/icon.ico` and the Morrow Mail version strings into that exe after the pack, and does not sign it. The NSIS installer and uninstaller icons are the same `build/icon.ico`. The taskbar, desktop shortcut, and installed exe use the icon inside `Morrow Mail.exe`.

4. The job uploads the NSIS setup exe, its `.blockmap`, the portable exe, and `latest.yml` to a **prerelease** on public `Coke1120/Morrow-Mail`. `latest.yml` is the Windows electron-updater feed and names the NSIS setup. The portable exe is a no-install download. `detectUpdateChannel` is `false`, so `0.1.0-alpha.N` still publishes `latest.yml`.

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

## Updater reads

`build.publish` is GitHub `Coke1120/Morrow-Mail`, `private: false`, `releaseType: prerelease`. The packaged app writes that into `resources/app-update.yml`. With `allowPrerelease` on, electron-updater reads the public prerelease feed (`https://github.com/Coke1120/Morrow-Mail/releases.atom`, then `alpha.yml` or `alpha-mac.yml` for an alpha tag, and `latest.yml` or `latest-mac.yml` when that channel file is absent).

A packaged install checks and downloads that feed with no GitHub token. `npm start` leaves the updater off.

`GH_TOKEN`, `GITHUB_TOKEN`, or the userData file `github-update.json` (the folder that holds `settings.json`) is optional:

```json
{ "token": "github_pat_..." }
```

The environment variable wins when both are set. `setFeedURL` passes that token only when one is configured, and keeps `private: false`. electron-updater then uses the GitHub API for that check. With no token it stays on the public feed. The token stays in memory. It is not written into `app-update.yml`. Do not commit `github-update.json`. The Actions token that uploads the release is not shipped inside the app.

A configured token that GitHub rejects is reported as rejected. A feed response that requires authentication (HTTP 401 or 403) explains how to set the token. The check runs when no token is configured.

## Product name, icon, and app id

`productName` is `Morrow Mail`. The macOS bundle display name (`CFBundleDisplayName` and `CFBundleName`) matches. The window title, the application menu, and About use that name.

The app id is `com.coke1120.morrow-mail`. Install Morrow Mail as its own app. This id is not the Swift Morrow Mail id `org.morrowmail.desktop` from [Coke1120/Morrow-Mail](https://github.com/Coke1120/Morrow-Mail).

The GitHub publish repo is `Coke1120/Morrow-Mail`. The npm package name is `morrow-mail`.

Icons are the Morrow Mail mark (forest green rounded square, pale envelope, rising sun):

- `build/icon.png` is the 1024 source. Linux uses it. The pack copies it to `resources/icon.png` for the running app.
- `build/icon.icns` is the macOS `.app` icon (`mac.icon`, `CFBundleIconFile`).
- `build/icon.ico` is the Windows exe, taskbar, shortcut, and NSIS installer icon.
- `build/morrow-icon.svg` matches `renderer/morrow-icon.svg`, which the rail uses.

`host/main.js` points the window and About at `resources/icon.png` when the app is packaged, and at `build/icon.png` in a dev checkout. On macOS it calls `app.dock.setIcon` so the Dock shows that mark. `npm start` is the Electron binary, so without that call the Dock shows Electron's icon.

A fresh install of the next release should show this mark on the `.app`, in the Dock, and on the Windows exe. If an older copy is already in `/Applications` or pinned in the Dock, macOS can keep the previous artwork until the icon cache is cleared:

```bash
touch "/Applications/Morrow Mail.app"
rm -rf "$HOME/Library/Caches/com.apple.iconservices.store"
killall Dock
```

Quit and reopen Morrow Mail after that. Launching the app also sets the Dock tile from `resources/icon.png`.

Mail, settings, and `ai.json` follow Electron's userData path for Morrow Mail once the app is ready. This build does not copy files from an older application-support folder. Keychain storage is described in [OAUTH.md](OAUTH.md).

## Version

`package.json` version drives the app and the release tag `v${version}`. Stay on `0.1.0-alpha.N`. The current version is `0.1.0-alpha.8`.
