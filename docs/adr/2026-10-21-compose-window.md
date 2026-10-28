# Compose opens in its own window

New Mail, Reply, Reply All, Forward, resumed drafts, scheduled-mail edit, and Bot review drafts used a modal `<dialog id="compose">` over the mail shell. The shell could not be used until that dialog closed.

## Decision

The mail shell calls `compose:open` with the same JSON seed `openCompose` already accepted. The host opens a separate `BrowserWindow` on `renderer/index.html?role=compose`. That page hides the mail chrome and opens the existing compose dialog as the window surface, so quoting, signatures, attachments, AI write, preview, and schedule stay one implementation.

Several compose windows may be open. There is no cap. Each window has its own renderer state. They are not parented to the shell and are not modal, so the mail window stays usable and a compose window does not hide with the shell. Windows cascade from the shell bounds.

Close matches the discard / keep-editing confirm. Close does not call `mail:upsertDraft`. Save draft stays its own button. A clean compose window, including a scheduled receipt, closes without that confirm. Quitting while a compose window refuses to close (the draft is still dirty, or the page has not answered) aborts the quit and focuses that confirm. Preventing close is required; destroying the window would drop the draft, and allowing the quit to proceed would do the same.

Undo send no longer stays in the compose window. See [Compose closes into Outbox](2026-10-28-compose-outbox-undo.md). Closing a compose window that has not queued a send still confirms before discarding unsaved edits and does not send.

The in-window dialog remains the compose window's surface. If `openComposeWindow` is missing, `presentCompose` still calls `openCompose` in the same page. That is the offline check path. The product preload always has the API, so the mail shell does not show compose as a modal.

A compose window does not subscribe to `mail:emailsUpdated`, does not call `mail:setOnline`, and does not report update readiness. The shell owns the mailbox list and the updater. The updater already refuses to install while any window other than the shell exists, so an open compose window blocks install.

Zoom and Cmd/Ctrl+N stay on the application menu and are delivered to the shell. Cmd/Ctrl+S and Cmd/Ctrl+Enter are page shortcuts in the focused compose window. On macOS the main window still hides on close. A compose window's close button closes that window.

Window bounds for compose are not written to `window-state.json`.

## Why a second window

A modal dialog cannot leave the shell interactive. A second BrowserWindow reuses the bundled renderer, the preload, and the dialog that already implements compose. Extracting a separate compose page would fork signatures, quote layout, and AI write.
