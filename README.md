# Morrow Mail

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Website](https://img.shields.io/badge/Website-hwl--hk.com-193c34)](https://hwl-hk.com/en/morrow-mail)

Website: [https://hwl-hk.com/en/morrow-mail](https://hwl-hk.com/en/morrow-mail)

Morrow Mail is an open-source Electron mail client. You connect your own accounts, read and send mail, and install the desktop app from GitHub Releases.

The npm package is `morrow-mail`. Source: [Coke1120/Morrow-Mail](https://github.com/Coke1120/Morrow-Mail). Downloads: [Releases](https://github.com/Coke1120/Morrow-Mail/releases). License: [MIT](LICENSE). [Code signing policy](CODE_SIGNING_POLICY.md). [Code of Conduct](CODE_OF_CONDUCT.md).

The app in this tree is Electron (`host/`, `renderer/`, `shared/`). The old SwiftUI, WinUI, and Rust snapshot is archival only, in [`legacy.zip`](legacy.zip). Do not unzip it for feature work. See [LEGACY.md](LEGACY.md).

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
- Packaging: electron-builder + electron-updater (unsigned alpha until SignPath approval). Windows and unsigned Mac feeds: Actions → **release** → Run workflow ([docs/PACKAGING.md](docs/PACKAGING.md)). [Code signing policy](CODE_SIGNING_POLICY.md)
- OAuth: One full Google consent; Microsoft uses Outlook IMAP/SMTP then one Graph consent for calendar, organize, Out of Office, and inbox rules. Google Desktop JSON stays out of git. See [docs/OAUTH.md](docs/OAUTH.md)
- Out of Office: Settings → Out of Office writes Gmail vacation settings or Microsoft automatic replies after confirmation. IMAP tries ManageSieve on port 4190 and does not send local automatic replies
- Bot bridge: default-off loopback API on `127.0.0.1:47831` for cached reads and inert draft proposals. See [docs/BOT_BRIDGE.md](docs/BOT_BRIDGE.md)
