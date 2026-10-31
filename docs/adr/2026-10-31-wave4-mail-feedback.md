# Wave4 mailbox feedback and removal sessions

## Decision

All Account Mail's Unread chip counts downloaded unread messages in each primary
folder: Gmail All Mail, with Inbox fallback, or Inbox for other accounts. It uses
the list's snooze exclusion, but never includes an already-read held row. Account
snapshots carry `cachedPrimaryUnreadCount`; provider-reported folder badges keep
their existing meaning and can include messages not downloaded here. Existing
account broadcasts refresh both accepted projections and definitive corrections.

Reviewed bulk Archive and Trash hide their frozen message IDs before submitting
background IPC in groups of at most four, yielding a frame and task between
groups. Pending rows remain hidden across list reloads until definitive settlement.
Failures, uncertainty and unattempted rows release the optimistic filter and
reconcile with the cache. Accepted is not completed, is not cancellable, and does
not create removal Undo. Journal durability and provider authorization are unchanged.

Removal Undo accumulates operation IDs across batches until restored or cleared.
Each receipt keeps its session ownership and metadata; cleared/replaced sessions
cannot be revived by late results. Pending batches survive restoration of every
currently completed item. Restores and new settlement receipts serialize without
replacing surviving checklist items. Changes to the same message remain separate;
restoring multiple conflicting operations together is refused, and the host's
existing identity checks remain authoritative for an individual restore.

All Account Mail's Out of Office strip only chooses a mailbox and opens that
mailbox's Settings. It does not invent a combined status, request every mailbox's
settings, or write provider settings. Single-mailbox status and review stay intact.

Agent navigation paints the last payload before refreshing. Cached refresh and
automatic stale triage use no page overlay; a status notice identifies in-flight
triage. Concurrent automatic triage reads join one request. Cold load and explicit
Refresh retain the busy overlay, and refresh failure preserves the prior payload.

## Boundaries

These are desktop-only changes. Auth, delivery, draft persistence, unread-hold
membership and reduced-motion behavior retain their existing contracts. Synthetic
checks do not establish native macOS cursor latency or live-provider behavior.
