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
- Edits those signatures from the toolbar (`mail:upsertSignature`, `mail:deleteSignature`): name plus text or HTML, and an optional default. The sample list stays in memory. A connected IMAP account keeps an empty list and rejects writes
- Drafts with AI from compose (`aiDraftWrite:start`, `aiDraftWrite:cancel`, `aiDraftWrite:event`) and lists reply suggestions on the open message (`aiDraftWrite:replySuggestions`). A missing API key is reported in place
- Shows the app version and checks or installs updates (`app:getVersion`, `host:updateGetState`, `host:updateCheck`, `host:updateInstall`)
- Edits theme, accent, conversation view, remote images, undo send, snooze, AI write on reply, folder chips, one-click tidy, and sidebar folder expansion (`config:setTheme`, `genmail:configSet*`). API keys stay in AI Setup
- Email Brain lists cached sections and writing rules (`emailBrain:getCached`). A user rule can be added, edited, or deleted. Refresh says it needs an AI key when the host returns `accepted: false`. Categories in that dialog load from `emailBrain:getCategories`, edit locally, and save with `emailBrain:saveCategories`. Add with AI needs an API key and shows the host error when the key is missing
- Email Brain skills library lists home and library skills in that same dialog (`emailBrain:getSkills`, `emailBrain:getLibrarySkills`). Clicking a row runs it (`emailBrain:runSkill`). The sample host returns a canned result with no API key. Match my tone opens Reply when a message is open. A connected mailbox returns `accepted: false`. A host error shows in the dialog
- AI Studio lists home and library skills (`nativeAgent:home:skills`, `nativeAgent:home:librarySkills`). Empty lists stay empty. A host error is shown in the dialog. This host does not run an agent
- Schedules a send from New Mail (`mail:scheduleSend`) and lists it (`mail:listScheduled`). The sample list stays in memory. A connected IMAP account reports that scheduled send is unavailable
- Replies or forwards the open message in that same dialog. Reply All adds other To and Cc addresses. Forward names attachments and does not upload them. The sample mailbox can fill and schedule either one

With no connected account the host answers from the built-in sample mailbox in `host/mailbox.js`, including star, archive, trash, move, snooze, and scheduled send. Translate, AI write, and reply suggestions show the host error when no API key is set. Email Brain still lists the cached snapshot, with an empty writing list, and refresh says it needs an AI key. Categories still load, edit, and save with no key. Skills still list and run a canned result with no key. Compose lists signatures saved on the sample mailbox. That mail is not yours and Send stays disabled. Scheduling a sample message only adds it to the list in New Mail. Connecting an account switches the same channels over to the live IMAP engine.

`GENMAIL_ASAR=/absolute/path/to/app.asar` still boots that external renderer and its preload. That is the only fallback.

## Follow-ups

Not in this slice, and not matching GenMail inside the Genspark launcher yet:

- Visual parity with that GenMail shell beyond the three-pane chrome in [PARITY_SHELL.md](PARITY_SHELL.md)
- Calendar, and the host preferences still unread in [PARITY_SHELL.md](PARITY_SHELL.md)
- The full agent skill runner
- Changing API keys from this window (AI Setup remains on the application menu)
