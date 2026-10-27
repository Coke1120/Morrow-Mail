# Morrow Mail

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Website](https://img.shields.io/badge/Website-hwl--hk.com-193c34)](https://hwl-hk.com/en/morrow-mail)
[![GitHub Sponsors](https://img.shields.io/badge/Sponsors-Coke1120-ea4aaa)](https://github.com/sponsors/Coke1120)
[![Buy Me a Coffee](https://img.shields.io/badge/Buy%20Me%20a%20Coffee-coke1120-FFDD00)](https://buymeacoffee.com/coke1120)

Website: [https://hwl-hk.com/en/morrow-mail](https://hwl-hk.com/en/morrow-mail)

Support: [GitHub Sponsors](https://github.com/sponsors/Coke1120) · [Buy Me a Coffee](https://buymeacoffee.com/coke1120)

Morrow Mail is an open-source Electron mail client. You connect your own accounts, read and send mail, and install the desktop app from GitHub Releases.

## Screenshots

![Morrow Mail demo inbox](docs/images/01-mailbox.png)

![Welcome message](docs/images/02-reader.png)

![About and updates](docs/images/03-about.png)

The npm package is `morrow-mail`. Source: [Coke1120/Morrow-Mail](https://github.com/Coke1120/Morrow-Mail). Downloads: [Releases](https://github.com/Coke1120/Morrow-Mail/releases). License: [MIT](LICENSE). Copyright (c) 2026 Leo Ho / HWL-HK. [Code signing policy](CODE_SIGNING_POLICY.md). [Code of Conduct](CODE_OF_CONDUCT.md).

The app in this tree is Electron (`host/`, `renderer/`, `shared/`). The old SwiftUI, WinUI, and Rust snapshot is archival only, in [`legacy.zip`](legacy.zip). Do not unzip it for feature work. See [LEGACY.md](LEGACY.md).

## Run (dev)

```bash
npm install
npm start
```

`npm start` boots the bundled renderer in `renderer/`.

Optional: set `MORROW_ASAR` to an `app.asar` path to load that external UI instead. Leave the variable unset for the first-party shell. See [docs/INDEPENDENT_UI.md](docs/INDEPENDENT_UI.md).

Secrets: macOS Keychain service `morrow-mail`, or Windows DPAPI under `%LOCALAPPDATA%\morrow-mail`. Env `MORROW_AI_API_KEY` / `XAI_API_KEY` overrides the AI key in API mode. Mailbox OAuth: see [docs/OAUTH.md](docs/OAUTH.md). To connect Gmail on a Release build, import your own Google Desktop client JSON in Settings → Accounts. Steps: [Bring your own Google Desktop client](docs/bring-your-own-google-oauth.md). Packaging and the app id: [docs/PACKAGING.md](docs/PACKAGING.md).

AI settings also offer **Continue with ChatGPT** for eligible ChatGPT plans, alongside the existing API key/custom endpoint option. Sign in in your system browser, use the optional one-time callback paste-back if needed, fetch your account's models, choose one, then Save AI. Credentials stay encrypted through OS secure storage on this computer. Automatic profile refresh, automatic triage and scheduled AI skills need a separate account opt-in. Manage usage opens ChatGPT settings; limits apply and there is no automatic API fallback. Native/live sign-in testing is pending; see the [provider design and validation boundary](docs/adr/2026-10-25-chatgpt-model-provider.md).


## Status

- Project skills for Cursor and Cloud Agents: `.agents/skills/`
- Host: IMAP engine + AI + bundled first-party UI (`MORROW_ASAR` optional)
- Search: toolbar search reads a local full-text index of synced subject, from, and body (`mail:searchLocal`). The list filter still matches only subject, from, and snippet of messages already loaded. `mail:search` still asks the server
- Agent triage and Email Brain skills: [docs/BRAIN_AGENT.md](docs/BRAIN_AGENT.md)
- Packaging: electron-builder + electron-updater (unsigned alpha until SignPath approval). Windows and unsigned Mac feeds: Actions → **release** → Run workflow ([docs/PACKAGING.md](docs/PACKAGING.md)). [Code signing policy](CODE_SIGNING_POLICY.md)
- OAuth: Separate Google mail and Calendar consent; Microsoft uses Outlook IMAP/SMTP then one Graph consent for calendar, organize, Out of Office, and inbox rules. Google Desktop JSON stays out of git. Import your own Desktop client in Settings. See [docs/OAUTH.md](docs/OAUTH.md) and [Bring your own Google Desktop client](docs/bring-your-own-google-oauth.md)
- Out of Office: Settings → Out of Office writes Gmail vacation settings or Microsoft automatic replies after confirmation. IMAP tries ManageSieve on port 4190 and does not send local automatic replies
- Bot bridge: default-off loopback API on `127.0.0.1:47831` for cached reads, inert draft proposals, and separately granted plain-text sends. Bot attachment bytes and mailbox draft CRUD are unavailable. Features → CLI lists capabilities, Tailscale steps, examples, and cancellation limits. See [docs/BOT_BRIDGE.md](docs/BOT_BRIDGE.md)
