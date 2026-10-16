# genmail-rea

Private Electron rewrite of GenMail Exact (pre-rebrand). Not the public [Morrow-Mail](https://github.com/Coke1120/Morrow-Mail) line.

## Run (dev)

```bash
npm install
# macOS with Genspark Super App installed, or:
# export GENMAIL_ASAR=/path/to/app.asar
npm start
```

Secrets: macOS Keychain / Windows DPAPI (`genmail-exact` service), or env `GENMAIL_AI_API_KEY` / `XAI_API_KEY`. OAuth: see [docs/OAUTH.md](docs/OAUTH.md). Packaging: [docs/PACKAGING.md](docs/PACKAGING.md).

## Status

- Host: IMAP engine + AI + GenMail UI loaded from external/bundled asar
- Packaging: electron-builder + electron-updater (unsigned alpha)
- OAuth: Google/Microsoft browser loopback (IMAP XOAUTH2); Microsoft client ID bundled; Google JSON via env
