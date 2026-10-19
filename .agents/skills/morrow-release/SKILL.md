---
name: morrow-release
description: Use when you bump the app version or ship an unsigned Windows and macOS release. The package.json version drives the v* tag.
---

# Version and unsigned release

1. Read `docs/PACKAGING.md` and `docs/UPDATER_TEST.md`.
2. Set `version` in `package.json`. The GitHub tag is `v` plus that version. A mismatch fails the release job.
3. Run the Actions workflow `release` (`.github/workflows/release.yml`) with `workflow_dispatch` on `main`, or push a matching `v*` tag.
4. Ship unsigned Windows x64 and an ad hoc signed macOS zip (`latest.yml` and `latest-mac.yml`). The macOS job waits for Windows, which creates the release first. Leave `signAndEditExecutable` false and the macOS custom ad hoc signer configured. Do not add Authenticode or Apple notarization in this workflow. SignPath wiring waits for subscription approval; see `docs/SIGNPATH.md`. Windows stays unsigned. macOS uses identity `-` for integrity only, with no signing key or Gatekeeper trust; do not set `mac.identity` to null because that bypasses the custom signer. Require strict codesign verification before archiving. Keep `scripts/windows-icon.js` on `afterPack` so the unsigned exe still receives `build/icon.ico`. Do not drop that hook while `signAndEditExecutable` stays false.
5. The installed app checks the public prerelease feed with no token. Pass `GH_TOKEN` or `GITHUB_TOKEN` only when a token is configured. Do not put a token in the repo. Publishing still uses the Actions `GITHUB_TOKEN`.
