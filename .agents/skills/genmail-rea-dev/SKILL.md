---
name: genmail-rea-dev
description: Use when you change the Electron host, the first-party renderer, or IPC. Boot stays independent of Genspark. Drafts do not send themselves.
---

# Host, renderer, and IPC

1. Read `docs/INDEPENDENT_UI.md`, `docs/PARITY_SHELL.md`, and `docs/BRAIN_AGENT.md`.
2. Boot the first-party `renderer/`. Do not add a Genspark cloud dependency.
3. Leave `GENMAIL_ASAR` unset. Set it only when you must load an external `app.asar`.
4. Do not add a sample mail UI or a lite mail UI.
5. Save a draft with `mail:upsertDraft`. Send only when the user chooses Send (`mail:send`). Do not auto-send a draft.
6. Write preferences to `settings.json`. Write the AI key to `ai.json` through `host/ai-config.js`.
