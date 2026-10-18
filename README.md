# Morrow Mail

Private Electron mail client. The npm package is `morrow-mail`. The GitHub repository may still be named `genmail-rea` until Leo renames it. The app in this tree is Electron (`host/`, `renderer/`, `shared/`). The old SwiftUI, WinUI, and Rust snapshot is archival only, in [`legacy.zip`](legacy.zip). Do not unzip it for feature work. See [LEGACY.md](LEGACY.md).

## Run (dev)

```bash
npm install
npm start
```

`npm start` boots the bundled renderer in `renderer/`. No Genspark install is required.

Optional: set `GENMAIL_ASAR` to an `app.asar` path to load that external UI instead (for example Genspark Super App's `Contents/Resources/app.asar`). Leave the variable unset for the first-party shell. See [docs/INDEPENDENT_UI.md](docs/INDEPENDENT_UI.md).

Secrets: macOS Keychain / Windows DPAPI. New items use the `morrow-mail` service and reads still accept `genmail-exact`. Env `GENMAIL_AI_API_KEY` / `XAI_API_KEY` still overrides the AI key. OAuth: see [docs/OAUTH.md](docs/OAUTH.md). Packaging and the app id: [docs/PACKAGING.md](docs/PACKAGING.md).

## Status

- Project skills for Cursor and Cloud Agents: `.agents/skills/`
- Host: IMAP engine + AI + bundled first-party UI (`GENMAIL_ASAR` optional)
- Agent triage and Email Brain skills: [docs/BRAIN_AGENT.md](docs/BRAIN_AGENT.md)
- Packaging: electron-builder + electron-updater (unsigned alpha). Windows and unsigned Mac feeds: Actions → **release** → Run workflow ([docs/PACKAGING.md](docs/PACKAGING.md))
- OAuth: IMAP XOAUTH2 baseline, Gmail/Graph label side-car, and a separate calendar grant. Google Desktop JSON stays out of git. See [docs/OAUTH.md](docs/OAUTH.md)
