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

## Deferred

- Settings panes, AI Studio, and the rest of GenmailSpace: calendar, Email Brain, AI write, translate, snooze UI, signatures, scheduled send.
- A pixel match to `GenmailSpace-*.css`. This shell only uses the first-party layout.
- Resizable panes and folder icons.
