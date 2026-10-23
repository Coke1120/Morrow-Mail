# Updater test checklist

For the current macOS manifest migration, use [SIGNED_UPDATES.md](SIGNED_UPDATES.md)
and its disposable-profile native test plan. The legacy production public key is bundled;
this branch is not ready for a release. The macOS feed checklist below is retained
as the historical Electron 0.2.4/0.2.5 behavior, not a successful transition claim.
Windows keeps its existing updater.

`Coke1120/Morrow-Mail` is public. The packaged app checks the prerelease feed with no GitHub token. `allowPrerelease` is on, so alpha prereleases count. `GH_TOKEN`, `GITHUB_TOKEN`, and legacy userData `github-update.json` are ignored by the app updater. A token in the feed configuration selects the private provider in electron-updater even with `private: false`; the public feed therefore never includes one. Publishing from CI still uses its build token.

`host:updateGetState`, `host:updateCheck`, and `host:updateInstall` are the shell channels. `host:updateState` pushes the same snapshot to the open windows.

## Attention badge and hourly check

The red ! sits on About & updates in the rail (`#update-attention`). It is shown when an update is available, downloading, ready to install, or needs a manual install. It stays hidden while Morrow is up to date, while a check has not found anything yet, and when a check fails.

The hourly timer starts from `updater.init()` after the app is ready and is cleared on `will-quit`. Each tick calls the same path as Check for updates. A tick does nothing when a check promise, a download, or an install is already running. Check still runs again after a finished attempt, even if `checking` was left set. This does not enable install-on-quit or a silent install. On a packaged app, Check already downloads when it finds a release; the hourly tick uses that same path.

`node scripts/check-update-schedule.js` covers the timer, the overlap skip, and the badge rules with fakes. A packaged check still needs a real feed:

1. Install a packaged Windows or macOS build that is older than the public release.
2. Leave About closed. After the startup check, the rail shows a red ! on About & updates.
3. Open About. The status names the release, and Check and Restart and install still work.
4. A current build, a check still running with nothing ready, and a failed check show no red !.
5. Leave Morrow open for about an hour. It checks again on its own. Quit clears the timer; a cancelled quit keeps it.

GitHub's anonymous rate limit still applies. A 429 stays the existing "try again later" error and does not show the badge. One check can call the feed more than once. Hourly checks from many machines on one network can still be limited.

## Windows

1. From `main`, run Actions → **release** → **Run workflow** ([PACKAGING.md](PACKAGING.md)). For `0.1.0-alpha.1` the prerelease tag is `v0.1.0-alpha.1`.
2. Confirm the release has `latest.yml`, `Morrow-Mail-Setup.exe`, `Morrow-Mail-Setup.exe.blockmap`, and `Morrow-Mail.exe`. `latest.yml` `path` and `files[0].url` are `Morrow-Mail-Setup.exe`. The app id is `com.coke1120.morrow-mail`. Install Morrow Mail once.
3. Install the NSIS setup. The portable exe does not take the in-app update.
4. Launch the installed app with no `GH_TOKEN` and no `github-update.json`. This version should report up to date when it is the newest prerelease.
5. Bump `package.json` to the next alpha, merge to `main`, and run **release** again.
6. Relaunch the older install the same way, with no token. After the check, the shell should show the new version available or downloaded. Install from the shell (`host:updateInstall`).

Unsigned NSIS builds show a Windows SmartScreen warning. Authenticode is a later step.

Local feed files, without uploading:

```bash
CSC_IDENTITY_AUTO_DISCOVERY=false npm run dist:win
```

`dist/latest.yml` `path` should be `Morrow-Mail-Setup.exe`. `dist/win-unpacked/resources/app.asar` should contain `renderer/index.html`. `dist/win-unpacked/resources/app-update.yml` should include `provider: github` and `private: false`.

## macOS (MBA)

```bash
CSC_IDENTITY_AUTO_DISCOVERY=false npm run dist:mac
```

The **release** workflow publishes `latest-mac.yml` with `path` `Morrow-Mail-arm64-mac.zip` and that ad hoc signed zip. Follow the native bundle and extracted-ZIP integrity checks in [PACKAGING.md](PACKAGING.md); Developer ID signing and notarization are not configured. A Mac that still expects `Morrow-Mail-<version>-arm64-mac.zip` in the signed manifest needs one manual install of the first stable-name release.

Launch that installed app with no `GH_TOKEN` and no `github-update.json`. Check for updates. The public prerelease feed is `releases.atom` plus `latest-mac.yml` on the newest prerelease. HTTP 401/403 reports a blocked public request (retry or check the network/proxy); HTTP 429 and rate-limit responses ask you to retry later. Missing feed assets and offline errors keep their diagnostic details. None asks for a token. Repeat the check with an invalid `GH_TOKEN` and a legacy `github-update.json`: the provider must still be public.
