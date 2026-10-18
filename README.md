# Morrow Mail

Private Electron mail client. The npm package is `morrow-mail`. The GitHub repository is `Coke1120/Morrow-Mail`. The app in this tree is Electron (`host/`, `renderer/`, `shared/`). The old SwiftUI, WinUI, and Rust snapshot is archival only, in [`legacy.zip`](legacy.zip). Do not unzip it for feature work. See [LEGACY.md](LEGACY.md).

## Run (dev)

```bash
npm install
npm start
```

`npm start` boots the bundled renderer in `renderer/`.

Optional: set `MORROW_ASAR` to an `app.asar` path to load that external UI instead. Leave the variable unset for the first-party shell. See [docs/INDEPENDENT_UI.md](docs/INDEPENDENT_UI.md).

Secrets: macOS Keychain service `morrow-mail`, or Windows DPAPI under `%LOCALAPPDATA%\morrow-mail`. Env `MORROW_AI_API_KEY` / `XAI_API_KEY` overrides the AI key. OAuth: see [docs/OAUTH.md](docs/OAUTH.md). Packaging and the app id: [docs/PACKAGING.md](docs/PACKAGING.md).

## Status

- Project skills for Cursor and Cloud Agents: `.agents/skills/`
- Host: IMAP engine + AI + bundled first-party UI (`MORROW_ASAR` optional)
- Search: toolbar search reads a local full-text index of synced subject, from, and body (`mail:searchLocal`). The list filter still matches only subject, from, and snippet of messages already loaded. `mail:search` still asks the server
- Agent triage and Email Brain skills: [docs/BRAIN_AGENT.md](docs/BRAIN_AGENT.md)
- Packaging: electron-builder + electron-updater (unsigned alpha). Windows and unsigned Mac feeds: Actions → **release** → Run workflow ([docs/PACKAGING.md](docs/PACKAGING.md))
- OAuth: IMAP XOAUTH2 baseline, Gmail/Graph label side-car, a separate calendar grant, and a separate Out of Office grant. Google Desktop JSON stays out of git. See [docs/OAUTH.md](docs/OAUTH.md)
- Out of Office: Settings → Out of Office writes Gmail vacation settings or Microsoft automatic replies after confirmation. IMAP tries ManageSieve on port 4190 and does not send local automatic replies
- Bot bridge: default-off loopback API on `127.0.0.1:47831` for cached reads and inert draft proposals. See [docs/BOT_BRIDGE.md](docs/BOT_BRIDGE.md)
