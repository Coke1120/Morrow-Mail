# Packaging & in-app updater

## Critical: UI asar

This host does **not** ship a renderer. At runtime it opens either:

1. `GENMAIL_ASAR` env path, or
2. `resources/ui.asar` next to the packaged app (`extraResources`), or
3. macOS default `/Applications/Genspark Super App.app/Contents/Resources/app.asar`

**A GitHub Release of the Electron shell alone will not boot** without one of the above. Bundling Genspark’s asar has licensing implications — Leo must approve before we vendor it.

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
- Packaged app checks on launch; IPC `update:getState` / `host:updateCheck` / `host:updateInstall`.
- Private repo requires `GH_TOKEN` (or `GITHUB_TOKEN`) in the environment of the running app **or** publish with electron-builder’s GitHub token so latest.yml is readable.
- Unpacked `npm start` keeps updater disabled (dev stub).

## Version

`package.json` version drives both the app and release tags. Prefer `v0.1.0-alpha.N` prereleases until rebrand.
