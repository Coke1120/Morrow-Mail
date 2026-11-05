# To Me matches only the owning mailbox's primary address

The Mail list needs a recipient filter that excludes Cc-only and Bcc-only mail.
Each cached message belongs to one account. A To address belonging to a different
connected account does not make that message addressed to its owning account.

Use the saved account email and cached To array only. Compare parsed mailbox
addresses exactly, without regard to case. Do not use sender aliases, plus or
Gmail dot equivalence, compose defaults, delivery headers or provider queries.
Sent mail addressed to the same account can match. Unknown recipient data does
not match. Existing mailbox and Gmail label-copy membership remains unchanged.

Register a deterministic SQLite function on the existing local connection.
It parses the provider's saved display-address strings and structured addresses,
with a fast path for bare addresses. A provider display string has one mailbox
per array entry; its terminal angle-bracket address takes precedence over literal
brackets or email text in the decoded name. Ambiguous angle text without that
terminal address does not match. Apply the same predicate before list paging,
counts and local search limits. This avoids a schema migration and a second
recipient index. Filtered summary and cursor versions include To-list revisions
and saved account identities, including draft recipient edits. Parsing runs only
when To Me is enabled; a large first filtered count remains synchronous.

The toggle keeps folder, text, Unread/Starred and sort choices, resets paging and
clears selection. It is not a folder, provider rule, persistent setting or bot
parameter. Outbox does not use it. Native provider validation is outside the
synthetic test scope.
