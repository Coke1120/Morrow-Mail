# genmail-rea

Private Electron rewrite of GenMail Exact (pre-rebrand). Not the public [Morrow-Mail](https://github.com/Coke1120/Morrow-Mail) line.

## Run (dev)

```bash
npm install
npm start
```

`npm start` boots the bundled renderer in `renderer/`. No Genspark install is required.

Optional: set `GENMAIL_ASAR` to an `app.asar` path to load that external UI instead (for example Genspark Super App's `Contents/Resources/app.asar`). Leave the variable unset for the first-party shell. See [docs/INDEPENDENT_UI.md](docs/INDEPENDENT_UI.md).

Secrets: macOS Keychain / Windows DPAPI (`genmail-exact` service), or env `GENMAIL_AI_API_KEY` / `XAI_API_KEY`. OAuth: see [docs/OAUTH.md](docs/OAUTH.md). Packaging: [docs/PACKAGING.md](docs/PACKAGING.md).

## Status

- Host: IMAP engine + AI + bundled first-party UI (`GENMAIL_ASAR` optional)
- Packaging: electron-builder + electron-updater (unsigned alpha). Windows feed: Actions → **release** → Run workflow ([docs/PACKAGING.md](docs/PACKAGING.md))
- OAuth: Google/Microsoft browser loopback (IMAP XOAUTH2); Microsoft client ID bundled; Google JSON via env
