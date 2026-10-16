# Independent UI

`npm start` loads `renderer/` through the host IPC that already exists. It does not open Genspark Super App, and it does not read `resources/ui.asar`, unless you set `GENMAIL_ASAR` to an `app.asar` path.

## What this shell does

- Lists accounts, folders, and messages (`mail:listAccounts`, `mail:listFromCache`)
- Refreshes the open folder (`mail:listFromNetwork`)
- Reads a message (`mail:openEmail`) and marks it read (`mail:markRead`)
- Connects an IMAP account (`mail:listImapSmtpPresets`, `mail:connectImapSmtp`), including a Custom IMAP / SMTP card
- Starts Google or Microsoft sign-in in the browser (`mail:addAccount`)
- Removes a connected account after a confirm (`mail:removeAccount`). Mail stays on the server
- Compose stub for a connected account: save draft (`mail:upsertDraft`) and send (`mail:send`)
- Searches mail (`mail:search`). Clearing the box returns to the open folder
- Lists a conversation when the host returns `threadMessages` or a `threadId` (`mail:listThreadMessages`)
- Lists attachments and can save or open them (`mail:downloadAttachment`, `mail:openAttachmentExternally`)

With no connected account the host answers from the built-in sample mailbox in `host/mailbox.js`. That mail is not yours and Send stays disabled. Connecting an account switches the same channels over to the live IMAP engine.

`GENMAIL_ASAR=/absolute/path/to/app.asar` still boots that external renderer and its preload. That is the only fallback.

## Follow-ups

Not in this slice, and not matching GenMail inside the Genspark launcher yet:

- Visual parity with that GenMail shell beyond the three-pane chrome in [PARITY_SHELL.md](PARITY_SHELL.md)
- Calendar, Email Brain, AI Write, and translate in this window
- Snooze, signatures, scheduled send
- Updater controls here (AI Setup remains on the application menu)
