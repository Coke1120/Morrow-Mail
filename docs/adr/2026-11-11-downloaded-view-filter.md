# Filter the complete downloaded view before paging

The list input is a case-insensitive literal substring of the displayed subject,
sender and preview, not toolbar token-prefix search. Apply the identical predicate
in both connected and Local Folders stores before count, sorting and pagination.
Keep the selected folder/virtual view, mailbox, flags, To Me and snooze scope.
Never expand into other folders or call provider search. Only downloaded content
is covered; sync-history settings remain the download boundary.

Keep 200-row pages and use offset paging for literal-filtered lists. Avoid stale
summary counts when displayed text changes. The renderer debounces typing and
invalidates outstanding responses immediately, before the debounce expires.
Changing or clearing the phrase resets paging; normal navigation cancels pending
filter work. Selected rows hidden by a filter retain their metadata for explicit
selection actions rather than silently falling back to the open message.

Toolbar search retains its ranked 100-result contract. Its secondary filter and
Outbox's filter remain bounded to returned/loaded rows, labelled explicitly. This
keeps their distinct search and scheduled-send semantics unchanged. Literal scans
can cost time on large downloaded views; do not move the full mailbox to the
renderer or replace literal Unicode semantics with SQLite ASCII lower/LIKE.
