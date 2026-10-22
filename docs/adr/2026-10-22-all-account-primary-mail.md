# All Account Mail uses each account's primary folder

All Account Mail used to query `folderKey: "inbox"` for every connected account.

Gmail's primary mailbox is All Mail (`well_known` `all`, or the Gmail All Mail path when that row has no well-known name yet). Every other account stays on Inbox, including an account that happens to have its own All folder. A Gmail account with no All Mail folder row yet uses Inbox, so that account is not blank.

The merged list stays on `mail:listFromCache`. `primaryMailboxes()` resolves the `(accountId, path)` pairs. The renderer sends those pairs with `folderKey: "primary"`. `pathsForKey("all")` is only the strict `well_known = all` lookup. It misses a Gmail All Mail row that is recognized by path, and it would skip the Inbox fallback, so All Account Mail does not use it alone. Snoozed threads stay hidden in this view, the same as Inbox. Opening one account's All Mail folder still lists them. The unread chip counts the same primary folders. Sync of a single Inbox or All Mail folder is unchanged, and this view does not start a provider search.
