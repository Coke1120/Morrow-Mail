# All Account Mail is a collapsible section

Issue: https://github.com/Coke1120/Morrow-Mail/issues/383

## Decision

All Account Mail is a sidebar section header, like an account row. Activating it expands or collapses its children. It does not open a message list.

The children are Inbox and Outbox. Inbox opens the same merged primary list the old All Account Mail row opened, including the Unread chip. Gmail still uses cached All Mail; other accounts still use Inbox. Outbox stays the local undo queue from [Compose closes into Outbox](2026-10-28-compose-outbox-undo.md).

Arrow Left and Arrow Right use the same folder-tree keys as the other carets. While the folder filter is showing a match, matching children stay visible and Left does not collapse the section.

## Collapse key

The state is stored in `settings.json` `sidebarCollapsedFolders`, the same object as nested folders (`morrow:configGetSidebarCollapsedFolders`, `morrow:configSetSidebarCollapsedFolders`).

The account key is `*`. The folder id is `all-account-mail`. Presence means collapsed. Absence means expanded. `*` is not a mailbox id.

Collapse All does not close this section.

## Out of scope

Renaming All Account Mail, a per-account Outbox, and the undo delay.
