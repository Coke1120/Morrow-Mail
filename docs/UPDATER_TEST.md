# Updater test checklist

The repo is private. The packaged app reads updates only when `GH_TOKEN` or `GITHUB_TOKEN` is set in that process, or when userData `github-update.json` contains `{"token":"..."}` (same folder as `settings.json`). Use a PAT with read access to `Coke1120/genmail-rea`. Do not put the token in the repo or in the asar. Without a token the shell asks for one and does not call the public `releases.atom` URL.

`host:updateGetState`, `host:updateCheck`, and `host:updateInstall` are the shell channels. `allowPrerelease` is on, so alpha prereleases count.

## Windows

1. From `main`, run Actions → **release** → **Run workflow** ([PACKAGING.md](PACKAGING.md)). For `0.1.0-alpha.1` the prerelease tag is `v0.1.0-alpha.1`.
2. Confirm the prerelease has `latest.yml`, `Morrow-Mail-Setup-<version>.exe` (dashes; older tags used `GenMail-REA-Setup-…`), that exe's `.blockmap`, and the portable exe. `latest.yml` `path` matches the dashed setup name. The app id `com.coke1120.morrow-mail` does not update an installed `com.coke1120.genmail-rea` copy. Install Morrow Mail once.
3. Install the NSIS setup. The portable exe does not take the in-app update.
4. Launch the installed app with `GH_TOKEN` set. This version should report up to date.
5. Bump `package.json` to the next alpha, merge to `main`, and run **release** again.
6. Relaunch the older install with the same `GH_TOKEN`. After the check, the shell should show the new version available or downloaded. Install from the shell (`host:updateInstall`).

Unsigned NSIS builds show a Windows SmartScreen warning. Authenticode is a later step.

Local feed files, without uploading:

```bash
CSC_IDENTITY_AUTO_DISCOVERY=false npm run dist:win
```

`dist/latest.yml` should name the NSIS setup. `dist/win-unpacked/resources/app.asar` should contain `renderer/index.html`. `dist/win-unpacked/resources/app-update.yml` should include `provider: github` and `private: true`.

## macOS (MBA)

```bash
CSC_IDENTITY_AUTO_DISCOVERY=false npm run dist:mac
```

The **release** workflow publishes unsigned `latest-mac.yml` with the Mac zip. Apple codesign stays on the MBA.
