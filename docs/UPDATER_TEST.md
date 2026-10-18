# Updater test checklist

`Coke1120/Morrow-Mail` is public. The packaged app checks the prerelease feed with no GitHub token. `allowPrerelease` is on, so alpha prereleases count. An optional token is `GH_TOKEN` or `GITHUB_TOKEN` in that process, or userData `github-update.json` containing `{"token":"..."}` (same folder as `settings.json`). Do not put a token in the repo or in the asar.

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

The **release** workflow publishes unsigned `latest-mac.yml` with the Mac zip. Apple codesign stays on the MBA.

Launch that installed app with no `GH_TOKEN` and no `github-update.json`. Check for updates. The public prerelease feed is `releases.atom` plus `latest-mac.yml` on the newest prerelease. A configured token that GitHub rejects shows `GitHub token was rejected.` A feed that answers 401 or 403 shows `Updates need a GitHub token.`
