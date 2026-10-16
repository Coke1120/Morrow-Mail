# Updater test checklist (macOS)

1. Build two consecutive versions (e.g. `0.1.0-alpha.1` then bump to `0.1.0-alpha.2`).
2. Publish alpha.1: `GH_TOKEN=… npm run publish:github` (or `gh release create` with electron-builder artifacts + `latest-mac.yml`).
3. Install / run alpha.1 packaged app with `GH_TOKEN` available if the repo is private.
4. Publish alpha.2; within ~minutes `update:getState` should show `available` / `downloaded`.
5. Quit & relaunch or call `host:updateInstall`.

**Blockers without Leo:** Apple codesign dialogs, private-release token in the installed app, and presence of `ui.asar` / Genspark.
