# Packaging & in-app updater

## UI

The packaged app boots the first-party renderer shipped in `renderer/` (see [INDEPENDENT_UI.md](INDEPENDENT_UI.md)). `electron-builder` includes that directory via `build.files`.

`GENMAIL_ASAR` is an optional override that loads an external `app.asar` instead. The app does not look for Genspark Super App or `resources/ui.asar` on its own. Do not commit an external asar.

## Build (unsigned alpha)

```bash
npm install
# macOS (on MBA):
CSC_IDENTITY_AUTO_DISCOVERY=false npm run dist:mac
# Windows x64 (cross-compile from Linux/mac with electron-builder):
CSC_IDENTITY_AUTO_DISCOVERY=false npm run dist:win
```

Artifacts land in `dist/`. Codesign / notarize / Authenticode are **not** configured; supply Apple identity + Windows cert later.

## Updater

- Library: `electron-updater` → GitHub Releases on private `Coke1120/genmail-rea`.
- Packaged app checks on launch; IPC `update:getState` / `host:updateCheck` / `host:updateInstall`. The first-party shell reads `host:updateGetState` and calls `host:updateCheck` / `host:updateInstall`.
- Private repo requires `GH_TOKEN` (or `GITHUB_TOKEN`) in the environment of the running app **or** publish with electron-builder’s GitHub token so latest.yml is readable.
- Unpacked `npm start` keeps updater disabled (dev stub).

## Version

`package.json` version drives both the app and release tags. Prefer `v0.1.0-alpha.N` prereleases until rebrand.
