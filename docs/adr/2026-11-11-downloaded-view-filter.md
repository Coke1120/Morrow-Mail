# Filter the complete downloaded view before paging

The list input is a case-insensitive literal substring of the displayed subject,
sender and preview, not toolbar token-prefix search. Apply this predicate in both
connected and Local Folders stores before count, sorting and pagination.
In a single connected account's selected system Drafts folder, the predicate
also matches any saved To address or display name, regardless of the Recipient
column or draft preview. Resolve that scope from account and folder metadata.
Compare decoded To values only and reuse the existing list revision for To edits.
Keep the selected folder/virtual view, mailbox, flags, To Me and snooze scope.
Never expand into other folders or call provider search. Only downloaded content
is covered; sync-history settings remain the download boundary.

Keep 200-row pages and use offset paging for literal-filtered lists. Avoid stale
summary counts when displayed text changes. The renderer debounces typing and
invalidates outstanding responses immediately, before the debounce expires.
While the user types, keep the previous page and its selection targets on screen.
Update the pending status immediately and repaint the rows when the result arrives.
During IME composition, background refreshes use the previously committed phrase.
Apply the new text after composition ends.
For a connected cache's first 200-row page, fewer than 200 matches prove the
exact total and oldest timestamp. Reuse those rows for both the summary and
the page in the same synchronous read. Full pages still need the exact count.
Requests combining a named folder with explicit mailbox pairs also use the
database summary because multiple SQL branches can return the same message.
Changing or clearing the phrase resets paging; normal navigation cancels pending
filter work. Selected rows hidden by a filter retain their metadata for explicit
selection actions rather than silently falling back to the open message.

Toolbar search retains its ranked 100-result contract. Its secondary filter and
Outbox's filter remain bounded to returned/loaded rows, labelled explicitly. This
keeps their distinct search and scheduled-send semantics unchanged. Literal scans
can cost time on large downloaded views; do not move the full mailbox to the
renderer or replace literal Unicode semantics with SQLite ASCII lower/LIKE.
