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
- Stars or unstars the open message (`mail:toggleStar`)
- Archives, trashes, or moves it (`mail:archive`, `mail:threadArchive`, `mail:delete`, `mail:threadTrash`, `mail:moveToFolder`) and can undo when the host returns `opIds` (`mail:undoRemoval`)
- Snoozes a thread for 1 hour, tonight, or tomorrow morning, and unsnoozes it (`mail:snoozeThread`, `mail:unsnoozeThread`, `mail:listSnoozed`)
- Translates the open message (`mail:translateStart`, `mail:translateCancel`, `mail:translate:event`). A missing API key is reported in the reading pane. The key itself is still set in AI Setup
- Inserts a host signature in compose (`mail:listSignatures`), or shows an empty state when the mailbox has none
- Drafts with AI from compose (`aiDraftWrite:start`, `aiDraftWrite:cancel`, `aiDraftWrite:event`) and lists reply suggestions on the open message (`aiDraftWrite:replySuggestions`). A missing API key is reported in place
- Shows the app version and checks or installs updates (`app:getVersion`, `host:updateGetState`, `host:updateCheck`, `host:updateInstall`)
- Shows a few host preferences (`config:getTheme`, `genmail:configGet*`). API keys stay in AI Setup
- Schedules a send from New Mail (`mail:scheduleSend`) and lists it (`mail:listScheduled`). The sample list stays in memory. A connected IMAP account reports that scheduled send is unavailable
- Replies or forwards the open message in that same dialog. Reply All adds other To and Cc addresses. Forward names attachments and does not upload them. The sample mailbox can fill and schedule either one

With no connected account the host answers from the built-in sample mailbox in `host/mailbox.js`, including star, archive, trash, move, snooze, and scheduled send. Translate, AI write, and reply suggestions show the host error when no API key is set, and compose shows no signatures. That mail is not yours and Send stays disabled. Scheduling a sample message only adds it to the list in New Mail. Connecting an account switches the same channels over to the live IMAP engine.

`GENMAIL_ASAR=/absolute/path/to/app.asar` still boots that external renderer and its preload. That is the only fallback.

## Follow-ups

Not in this slice, and not matching GenMail inside the Genspark launcher yet:

- Visual parity with that GenMail shell beyond the three-pane chrome in [PARITY_SHELL.md](PARITY_SHELL.md)
- Calendar, Email Brain, and the signatures editor
- Signatures editor
- Writing settings, or changing API keys, from this window (AI Setup remains on the application menu)
