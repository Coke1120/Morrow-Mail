# Shell parity

First-party `renderer/` chrome for the three-pane mail shell. Layout follows the host IPC already in this repo. The Genspark `app.asar` is not vendored and was not required to boot.

## Matched

- Folder sidebar from each account's `folders.primary` then `folders.more` (Inbox, Sent, Drafts, and any other folder the host returns). A non-zero `unreadCount` is shown on the row.
- Message list: sender, subject, date, snippet. The open row sets `aria-current`. Unread rows are bold, with a dot. ↑ and ↓ move a cursor; Enter opens that row (a focused row uses the button's own click).
- Reading pane: subject, from, date, To and Cc when the message has them, then the body. Empty state when nothing is open. Opening an unread message still calls `mail:markRead`.
- Toolbar actions are unchanged: Refresh (`mail:listFromNetwork`), Connect account (`mail:connectImapSmtp`, `mail:addAccount`), Remove account (`mail:removeAccount`), New Mail (`mail:upsertDraft`, `mail:send`).
- Search: the toolbar box submits `mail:search` with `query`, `limit`, and `filters`. Results replace the message list. Clearing the box, or choosing a folder, loads that folder again with `mail:listFromCache`.
- Conversation: the reader uses `threadMessages` from `mail:openEmail` when the host sends any. If that list is empty and the message has `threadId`, it calls `mail:listThreadMessages`. Two or more members are listed; the message you opened stays the body.
- Attachments: the reader lists `attachments` from the open message (name and size). Save calls `mail:downloadAttachment`. Open calls `mail:openAttachmentExternally`. A message that only sets `hasAttachments` shows that fact with no buttons.
- Star on the open message (`mail:toggleStar`). A starred row shows a star. In the sample mailbox, the Starred folder lists starred mail.
- Archive and Trash. One message uses `mail:archive` or `mail:delete`. A conversation uses `mail:threadArchive` or `mail:threadTrash`.
- Move (`mail:moveToFolder`) picks a folder from the open message's account.
- Snooze presets are 1 hour, tonight, and tomorrow morning (`mail:snoozeThread`). Unsnooze (`mail:unsnoozeThread`) shows when `mail:listSnoozed` says that thread is snoozed. Tonight is 18:00, then 22:00, then the next 18:00.
- Undo (`mail:undoRemoval`) appears when archive, trash, or move returns `opIds`.
- The folder and message panes drag-resize. Each folder row has an icon. At about 1100×700 the three panes stay side by side.
- Translate sits in the reading pane: a short language list, Translate, and Cancel. Visible body paragraphs go to `mail:translateStart` as `{ node_id, text }` nodes. `mail:translate:event` fills the result under the original text. A missing AI key shows the host error. Cancel calls `mail:translateCancel`. AI Setup stays the separate host window.
- Compose calls `mail:listSignatures`. An empty list shows “No signatures.” A row is `{ id, name, text }` or `{ id, name, html }`. The picker inserts the account default (`defaultSignaturePerAccount`, otherwise `defaultSignatureId`) and can switch or clear it. The signature text is part of the message body.
- Updater strip: the running version from `app:getVersion`, Check (`host:updateCheck`), and Install (`host:updateInstall`) when `host:updateGetState` reports a downloaded update. The same snapshot supplies the idle, checking, downloading, and error lines. An unpackaged build stays on the host stub (`enabled: false`).
- Settings lists theme, accent, conversation view, remote images, undo send, and snooze from `config:getTheme` and the existing `genmail:configGet*` stubs. The host has no matching set channels, so the list is read-only. API keys stay in AI Setup on the GenMail menu.

## Deferred

- Full settings, AI Studio, calendar, Email Brain, AI write, signatures editor, scheduled send.
- A pixel match to `GenmailSpace-*.css`. This shell only uses the first-party layout.
