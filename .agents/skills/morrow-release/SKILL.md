---
name: morrow-release
description: Use when you bump the app version or ship an unsigned Windows and macOS prerelease. The package.json version drives the v* tag.
---

# Version and unsigned prerelease

1. Read `docs/PACKAGING.md` and `docs/UPDATER_TEST.md`.
2. Set `version` in `package.json`. The GitHub tag is `v` plus that version. A mismatch fails the release job.
3. Run the Actions workflow `release` (`.github/workflows/release.yml`) with `workflow_dispatch` on `main`, or push a matching `v*` tag.
4. Ship unsigned Windows x64 and an unsigned macOS zip (`latest.yml` and `latest-mac.yml`). The macOS job waits for Windows, which creates the prerelease first. Leave `signAndEditExecutable` false and `mac.identity` null. Do not add Authenticode or Apple notarization in this workflow.
5. The installed app checks the public prerelease feed with no token. Pass `GH_TOKEN` or `GITHUB_TOKEN` only when a token is configured. Do not put a token in the repo. Publishing still uses the Actions `GITHUB_TOKEN`.
