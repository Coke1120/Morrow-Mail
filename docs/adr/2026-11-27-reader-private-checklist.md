# Reader-only private message checklist

An explicit text selection from a complete downloaded message can become a
checklist item in the Reader. The separate list shows its saved excerpt rather
than modifying message DOM or selecting a potentially different occurrence.
Changing HTML/plain-text presentation does not change the saved list. Selection
and progress never enter reply quotes, draft payloads, exports, Preview Send,
Agent, AI or mailbox requests.

The first-party Reader IPC reuses the source proof for the selected shell message
or a seeded detached Reader. The offline mail database binds the bounded excerpt
and its progress to the account, opaque cached message ID and provider identity.
An account epoch change blocks stale operations without expiring marks on
unchanged messages after an ordinary reopen. Purging the source cache row or
removing the account also removes associated marks. This local feature does not
copy marks when a provider gives a moved message a new identity. Local Folders
and Compose reference-pane integration are out of scope.
