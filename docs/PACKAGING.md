# Packaging & in-app updater

## UI

The packaged app boots the first-party renderer shipped in `renderer/` (see [INDEPENDENT_UI.md](INDEPENDENT_UI.md)). `electron-builder` includes that directory via `build.files`. An external `app.asar` is not required.

`MORROW_ASAR` is an optional override that loads an external `app.asar` instead. The app does not look for `resources/ui.asar` on its own. Do not commit an external asar.

## Windows packaging

The draft signed-updater workflow requires an approved public root and `MORROW_UPDATE_SIGNING_KEY`; the current empty root blocks publication. See [signed update gates](SIGNED_UPDATES.md#release-workflow-gate).

Workflow: `.github/workflows/release.yml` (Actions tab → **release**). It runs on **Run workflow** and on a `v*` tag push. One run publishes Windows and an ad hoc signed macOS zip to the same GitHub release. Pull requests stay on the `ci` check job.

1. For an authorized release, use a new stable `major.minor.patch` package version and reviewed source on `main`. The GitHub tag is `v` plus that version.
2. Actions → **release** → **Run workflow**, branch `main`.
3. The job runs `npm run check`, then unsigned Windows x64:

```bash
CSC_IDENTITY_AUTO_DISCOVERY=false npm run dist:win -- --publish never
```

`dist:win` is `electron-builder --win nsis portable --x64`. `build.win.signAndEditExecutable` is `false`. Authenticode is not configured. SignPath Foundation signing is pending approval and is not in this workflow. See [Code signing policy](../CODE_SIGNING_POLICY.md) and [SIGNPATH.md](SIGNPATH.md).

That flag also skips electron-builder's own resource edit, which would leave the installed `Morrow Mail.exe` as Electron's icon and product name. `build.afterPack` (`scripts/windows-icon.js`) writes `build/icon.ico` and the Morrow Mail version strings into that exe after the pack, and does not sign it. The hook reopens the edited executable and verifies every icon image and product version, plus preservation of unrelated resources (including Electron's ASAR integrity record). The NSIS installer and uninstaller icons are the same `build/icon.ico`. The taskbar, desktop shortcut, and installed exe use the icon inside `Morrow Mail.exe`.

4. After both builds succeed, the final publisher uploads the NSIS setup exe, its `.blockmap`, the portable exe, `latest.yml`, the macOS ZIP/feed/blockmap, signed manifest pair and provenance records to a draft release. It verifies downloaded bytes before promotion. `latest.yml` remains the Windows electron-updater feed and names the NSIS setup; the portable exe is a no-install download.

The feed URL uses dashes (`Morrow-Mail-Setup-VERSION.exe`); local build filenames may contain spaces. Staging checks that feed hashes and sizes match the final artifacts.

The final publisher binds a new release tag to the exact workflow source SHA, after both platform artifacts pass validation.

A version tag must match the stable package version and exact source commit. Existing releases are rejected without overwriting assets.

Same unsigned build on a dev machine, without uploading:

```bash
npm ci
CSC_IDENTITY_AUTO_DISCOVERY=false npm run dist:win
```

Artifacts land in `dist/` (`latest.yml`, `*Setup*.exe`, `*.exe.blockmap`, portable exe).

On Linux, the NSIS uninstaller step needs Wine, including `wine32:i386`. The release job runs on `windows-latest` and does not use Wine.

The publisher stages a draft, uploads both platform sets and verifies downloaded bytes before promotion. Failed drafts require review; automatic reruns do not overwrite them.

## macOS

The same **release** workflow runs on `macos-latest` after Windows and publishes an ad hoc signed zip plus `latest-mac.yml`. `build.mac.sign` invokes `scripts/sign-macos.js` after bundle/resource edits and before ZIP creation. The existing `@electron/osx-sign` dependency signs nested code inside-out with identity `-`, then seals the outer app. A failing `codesign --verify --deep --strict` aborts packaging before upload. No Apple certificate or provisioning profile is used; notarization is explicitly disabled. The separate Ed25519 manifest requires the approved release signing secret and does not establish Gatekeeper trust.

Previously `mac.identity: null` made electron-builder 25.1.8 return before signing, leaving the modified Electron bundle without a fresh resource seal. The official v0.2.3 ARM64 ZIP was reported to fail verification with `code has no resources but signature indicates they must be present` on macOS. A GitHub-matching ZIP hash does not establish signature validity.

Ad hoc signing provides local integrity only. It is **not Developer ID signing or notarization**, and does not establish Gatekeeper trust. Do not remove quarantine or disable protections to validate this change.

Local ARM64 build without publishing (on macOS, with dependencies already available):

```bash
CSC_IDENTITY_AUTO_DISCOVERY=false npm run dist:mac -- --arm64 --publish never
codesign --verify --deep --strict --verbose=2 "dist/mac-arm64/Morrow Mail.app"
codesign -dv --verbose=4 "dist/mac-arm64/Morrow Mail.app"
```

Before approving the fix, also extract the generated ZIP into a fresh temporary directory using `ditto -x -k`, and run both commands on that extracted `.app`. Require successful strict verification for both copies and `Signature=adhoc` with no Developer ID/TeamIdentifier. Compare the extracted app's files and symlinks with the packaged app. `spctl --assess --type execute --verbose=4` may still reject an ad hoc app; this is not the integrity test. Linux hook tests mock signing and cannot establish native signature validity. Do not launch the app as part of this check.

## Updater reads

The current macOS source uses the authenticated manifest/installer described in
[SIGNED_UPDATES.md](SIGNED_UPDATES.md). Its production public key is deliberately
unset, so macOS automatic updates fail closed. Publication gating and native
transition tests are still required before shipping this migration. Electron
0.2.4/0.2.5 installations require a one-time manual bridge installation; a future
release cannot retroactively change their updater. The feed behavior below remains
applicable to Windows and describes the historical macOS Squirrel path.

`build.publish` is GitHub `Coke1120/Morrow-Mail`, `private: false`, `releaseType: release`. The packaged app writes that into `resources/app-update.yml`. With `allowPrerelease` on, electron-updater reads the public prerelease feed (`https://github.com/Coke1120/Morrow-Mail/releases.atom`, then `alpha.yml` or `alpha-mac.yml` for an alpha tag, and `latest.yml` or `latest-mac.yml` when that channel file is absent).

A packaged install checks and downloads that feed with no GitHub token. `npm start` leaves the updater off.

The updater ignores `GH_TOKEN`, `GITHUB_TOKEN`, and legacy `github-update.json`. It always uses the public provider without a token. HTTP 401/403 indicates a blocked request; rate limiting asks you to retry later. Neither implies that this public repository needs credentials. CI publishing still uses its build token.

## Product name, icon, and app id

`productName` is `Morrow Mail`. The macOS bundle display name (`CFBundleDisplayName` and `CFBundleName`) matches. The window title, the application menu, and About use that name.

The app id is `com.coke1120.morrow-mail`. Install Morrow Mail as its own app. This id is not the Swift Morrow Mail id `org.morrowmail.desktop` from [Coke1120/Morrow-Mail](https://github.com/Coke1120/Morrow-Mail).

The GitHub publish repo is `Coke1120/Morrow-Mail`. The npm package name is `morrow-mail`.

Icons are the Morrow Mail mark (forest green rounded square, pale envelope, rising sun):

- `build/icon.png` is the 1024 source. Linux uses it. The pack copies it to `resources/icon.png` for the running app.
- `build/icon.icns` is the macOS `.app` icon (`mac.icon`, `CFBundleIconFile`).
- `build/icon.ico` is the Windows exe, taskbar, shortcut, and NSIS installer icon. It includes 16, 20, 24, 32, 40, 48, 64, 128, and 256 px images from `build/icon.png`. The pack also copies it to `resources/icon.ico` for Windows BrowserWindow icons.
- `build/morrow-icon.svg` matches `renderer/morrow-icon.svg`, which the rail uses.

`host/main.js` points the window and About at `resources/icon.ico` on Windows, with a PNG fallback. Other platforms use `resources/icon.png`; a dev checkout uses the corresponding file in `build/`. On macOS it calls `app.dock.setIcon` so the Dock shows that mark. `npm start` is the Electron binary, so without that call the Dock shows Electron's icon.

On Windows, verify the installed executable (not only the NSIS wrapper) with `node scripts/check-windows-icon.js "path/to/Morrow Mail.exe"`. An existing taskbar pin may still refer to another installation or cache older artwork: quit all copies, launch the installed executable, then unpin and repin that running app. The app does not clear the system icon cache or change the stable AppUserModelID.

A fresh install of the next release should show this mark on the `.app`, in the Dock, and on the Windows exe. If an older copy is already in `/Applications` or pinned in the Dock, macOS can keep the previous artwork until the icon cache is cleared:

```bash
touch "/Applications/Morrow Mail.app"
rm -rf "$HOME/Library/Caches/com.apple.iconservices.store"
killall Dock
```

Quit and reopen Morrow Mail after that. Launching the app also sets the Dock tile from `resources/icon.png`.

Mail, settings, and `ai.json` follow Electron's userData path for Morrow Mail once the app is ready. This build does not copy files from an older application-support folder. Keychain storage is described in [OAUTH.md](OAUTH.md).

## Version

`package.json` version drives the app and the release tag `v${version}`. Semver from `package.json` (currently `0.2.5`).
