# Shell parity (slice 1)

First-party `renderer/` chrome for the three-pane mail shell. Layout follows the host IPC already in this repo (`mail:listAccounts`, `mail:listFromCache`, `mail:openEmail`). The Genspark `app.asar` is not vendored and was not required to boot.

## Matched

- Folder sidebar from each account's `folders.primary` then `folders.more` (Inbox, Sent, Drafts, and any other folder the host returns). A non-zero `unreadCount` is shown on the row.
- Message list: sender, subject, date, snippet. The open row sets `aria-current`. Unread rows are bold, with a dot. ↑ and ↓ move a cursor; Enter opens that row (a focused row uses the button's own click).
- Reading pane: subject, from, date, To and Cc when the message has them, then the body. Empty state when nothing is open. Opening an unread message still calls `mail:markRead`.
- Toolbar actions are unchanged: Refresh (`mail:listFromNetwork`), Connect account (`mail:connectImapSmtp`, `mail:addAccount`), Remove account (`mail:removeAccount`), New Mail (`mail:upsertDraft`, `mail:send`).

## Deferred

- Settings panes, AI Studio, and the rest of GenmailSpace: calendar, Email Brain, AI write, translate, search, snooze, conversation view, attachment open/save, signatures, scheduled send.
- A pixel match to `GenmailSpace-*.css`. This slice only tightens the first-party shell.
- Resizable panes, folder icons, and multi-message thread bodies. The reader still shows the opened message plus a thread count when the host returns one.
