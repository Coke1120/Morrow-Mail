# Updater test checklist

`Coke1120/Morrow-Mail` is public. The packaged app checks the prerelease feed with no GitHub token. `allowPrerelease` is on, so alpha prereleases count. `GH_TOKEN`, `GITHUB_TOKEN`, and legacy userData `github-update.json` are ignored by the app updater. A token in the feed configuration selects the private provider in electron-updater even with `private: false`; the public feed therefore never includes one. Publishing from CI still uses its build token.

`host:updateGetState`, `host:updateCheck`, and `host:updateInstall` are the shell channels.

## Windows

1. From `main`, run Actions → **release** → **Run workflow** ([PACKAGING.md](PACKAGING.md)). For `0.1.0-alpha.1` the prerelease tag is `v0.1.0-alpha.1`.
2. Confirm the prerelease has `latest.yml`, `Morrow-Mail-Setup-<version>.exe` (dashes), that exe's `.blockmap`, and the portable exe. `latest.yml` `path` matches the dashed setup name. The app id is `com.coke1120.morrow-mail`. Install Morrow Mail once.
3. Install the NSIS setup. The portable exe does not take the in-app update.
4. Launch the installed app with no `GH_TOKEN` and no `github-update.json`. This version should report up to date when it is the newest prerelease.
5. Bump `package.json` to the next alpha, merge to `main`, and run **release** again.
6. Relaunch the older install the same way, with no token. After the check, the shell should show the new version available or downloaded. Install from the shell (`host:updateInstall`).

Unsigned NSIS builds show a Windows SmartScreen warning. Authenticode is a later step.

Local feed files, without uploading:

```bash
CSC_IDENTITY_AUTO_DISCOVERY=false npm run dist:win
```

`dist/latest.yml` should name the NSIS setup. `dist/win-unpacked/resources/app.asar` should contain `renderer/index.html`. `dist/win-unpacked/resources/app-update.yml` should include `provider: github` and `private: false`.

## macOS (MBA)

```bash
CSC_IDENTITY_AUTO_DISCOVERY=false npm run dist:mac
```

The **release** workflow publishes `latest-mac.yml` with the ad hoc signed Mac zip. Follow the native bundle and extracted-ZIP integrity checks in [PACKAGING.md](PACKAGING.md); Developer ID signing and notarization are not configured.

Launch that installed app with no `GH_TOKEN` and no `github-update.json`. Check for updates. The public prerelease feed is `releases.atom` plus `latest-mac.yml` on the newest prerelease. HTTP 401/403 reports a blocked public request (retry or check the network/proxy); HTTP 429 and rate-limit responses ask you to retry later. Missing feed assets and offline errors keep their diagnostic details. None asks for a token. Repeat the check with an invalid `GH_TOKEN` and a legacy `github-update.json`: the provider must still be public.
