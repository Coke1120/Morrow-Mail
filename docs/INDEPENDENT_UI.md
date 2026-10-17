# Independent UI

`npm start` loads `renderer/` through the host IPC that already exists. It does not open Genspark Super App, and it does not read `resources/ui.asar`, unless you set `GENMAIL_ASAR` to an `app.asar` path.

## What this shell does

- Lists accounts, folders, and messages (`mail:listAccounts`, `mail:listFromCache`). A filter above the list matches subject, from, and snippet of messages already loaded and does not call `mail:search`
- Message rows show icon buttons labeled Mark read or unread (`mail:markRead`), Delete (`mail:delete`), Reply, and Reply All on hover and when the row is focused. Reply uses the open message, or `mail:openEmail`, then the compose dialog
- Syncs the open folder from the toolbar (`mail:listFromNetwork`)
- Reads a message (`mail:openEmail`) and marks it read (`mail:markRead`). The reading toolbar is icon buttons for Reply, Reply All, Forward, Star, Archive, and Trash. Reply All is always there. Remote `http` and `https` images stay blocked until Load remote content on that message, unless remote images are on in Settings. That allow lasts for the session and is not saved
- Connects an IMAP account (`mail:listImapSmtpPresets`, `mail:connectImapSmtp`), including a Custom IMAP / SMTP card
- Starts Google or Microsoft sign-in in the browser (`mail:addAccount`) for the IMAP baseline. A second consent (`mail:grantOrganize`) loads Gmail labels or Outlook mail folders from the provider API. Without that grant the sidebar keeps the IMAP folders and does not invent labels
- Removes a connected account after a confirm (`mail:removeAccount`). Mail stays on the server
- Compose stub for a connected account: save draft (`mail:upsertDraft`) and send (`mail:send`)
- Searches mail (`mail:search`). Clearing the box returns to the open folder
- Lists a conversation when the host returns `threadMessages` or a `threadId` (`mail:listThreadMessages`)
- Lists attachments and can save or open them (`mail:downloadAttachment`, `mail:openAttachmentExternally`)
- Stars or unstars the open message (`mail:toggleStar`)
- Archives, trashes, or moves it (`mail:archive`, `mail:threadArchive`, `mail:delete`, `mail:threadTrash`, `mail:moveToFolder`) and can undo when the host returns `opIds` (`mail:undoRemoval`)
- Snoozes a thread for 1 hour, tonight, or tomorrow morning, and unsnoozes it (`mail:snoozeThread`, `mail:unsnoozeThread`, `mail:listSnoozed`)
- Translates the open message (`mail:translateStart`, `mail:translateCancel`, `mail:translate:event`). A missing API key is reported in the reading pane. The key is set in Settings or GenMail → AI Setup
- Inserts a host signature in compose (`mail:listSignatures`), or shows an empty state when the mailbox has none
- Edits those signatures from Settings (`mail:upsertSignature`, `mail:deleteSignature`): name plus text or HTML, and an optional default. The sample list stays in memory. A connected IMAP account keeps an empty list and rejects writes
- Drafts with AI from compose (`aiDraftWrite:start`, `aiDraftWrite:cancel`, `aiDraftWrite:event`) and lists reply suggestions on the open message (`aiDraftWrite:replySuggestions`). A missing API key is reported in place
- Calendar (`calendar:status`, `calendar:list`, `calendar:createEvent`, `calendar:connect`) lists and creates events from Google Calendar or Microsoft Graph for the visible month. The grid and agenda show the provider's title, time, and location. With no mailbox, no token, or when Google Desktop OAuth is not configured, the page says what is missing and does not draw events
- Shows the app version and checks or installs updates (`app:getVersion`, `host:updateGetState`, `host:updateCheck`, `host:updateInstall`)
- Edits theme, accent, conversation view, remote images, undo send, snooze, AI write on reply, folder chips, one-click tidy, and sidebar folder expansion (`config:setTheme`, `genmail:configSet*`). Base URL, model id, and API key are set in that same Settings dialog (`host:aiGetConfig`, `host:aiSaveConfig`, `host:aiListModels`, `host:aiTest`) and in GenMail → AI Setup. The key stays in local `ai.json`, not `settings.json`. Settings and the other dialogs scroll their body so Save and the AI fields stay reachable on a short window
- Email Brain opens in the left sidebar, with the folders, into Profile, Categories, and Skills. Profile lists cached sections, persona meta when present, and writing rules (`emailBrain:getCached`). A user rule can be added, edited, or deleted. A learned row can be fixed or forgotten. Refresh and Rebuild say they need an AI key in GenMail → AI Setup when the host returns `accepted: false`. No mailbox or an empty cache is a host error and does not use sample mail. Categories in that sidebar load from `emailBrain:getCategories`, edit locally, and save with `emailBrain:saveCategories`. Add with AI and Fix category need an API key and show the host error when the key is missing
- Email Brain skills library lists home and library skills in that same sidebar (`emailBrain:getSkills`, `emailBrain:getLibrarySkills`). Each row shows its description and that it runs on demand. Install and remove persist in the local brain store (`emailBrain:installSkill`, `emailBrain:removeSkill`). Running a skill (`emailBrain:runSkill`) calls the configured model with cached mailbox context and shows the result in the panel. No API key or no mailbox returns `accepted: false`. Drafts open in compose for review. Organize moves wait for confirm
- Agent chat is the left sidebar, opened from the rail or the toolbar Agent button. The transcript and composer are the primary surface (`nativeAgent:chat`, `nativeAgent:chatHistory`). Standing notes live in `agent-memory.json` (`nativeAgent:memorySet`). Triage (`nativeAgent:triage`) files recent inbox mail into Brain categories. Each row can open that message. Home and library skills use `nativeAgent:home:skills` and `nativeAgent:home:librarySkills`. Brief This Person takes the open message or an email address. Run history uses `nativeAgent:history` and can reopen a saved run in the transcript. Missing key, missing mailbox, and an empty cache stay empty of mail. Drafts stay in compose until you send them
- Schedules a send from New Mail (`mail:scheduleSend`) and lists it (`mail:listScheduled`). The sample list stays in memory. A connected IMAP account reports that scheduled send is unavailable
- Replies or forwards the open message in that same dialog. Reply puts the sender in To. Reply All puts the sender in To and the other To and Cc addresses in Cc. Forward names attachments and does not upload them. Compose lays out To, Cc, Bcc, subject, and the body. The sample mailbox can fill and schedule either one. Signatures stay one list: `defaultSignaturePerAccount` is empty and IMAP rejects writes, so there is no per-account signature menu

With no connected account the host answers from the built-in sample mailbox in `host/mailbox.js`, including star, archive, trash, move, snooze, and scheduled send. Translate, AI write, and reply suggestions show the host error when no API key is set. Email Brain still lists the cached snapshot, with an empty writing list, and refresh says it needs an AI key. Categories still load, edit, and save with no key. Skills list the GenMail catalog and refuse to run until an API key and a connected mailbox are present. Agent triage does the same and does not show the sample mailbox. Compose lists signatures saved on the sample mailbox. That mail is not yours and Send stays disabled. Scheduling a sample message only adds it to the list in New Mail. Connecting an account switches the same channels over to the live IMAP engine.

`GENMAIL_ASAR=/absolute/path/to/app.asar` still boots that external renderer and its preload. That is the only fallback.

## Follow-ups

Not in this slice, and not matching GenMail inside the Genspark launcher yet:

- Visual gaps still listed in [PARITY_SHELL.md](PARITY_SHELL.md): category chips, toolbar mail actions, the mail-only rail, and the settings dialog
- Host preferences still unread in [PARITY_SHELL.md](PARITY_SHELL.md)
- Unattended skill schedules (skills run only when you ask)
