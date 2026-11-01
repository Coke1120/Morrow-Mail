# Runtime mail queries beyond 10k rows

## Decision

Local search's list caller requests the existing explicit metadata projection.
Full-row database callers and on-demand message opens retain body access. Selected
account membership is applied inside every prefix posting aggregate, before
GROUP BY; token AND joins, maximum per-field weight, summed rank and timestamp/id
tie breaking are unchanged. There is no early candidate cap or approximate rank.
An index-only probe examines at most 2,049 prefix postings per token. Selective
prefixes (at most 2,048 postings) drive the term-range index, then account lookup
before grouping; broader prefixes let SQLite plan from the account. The probe
chooses only the access path: both paths rank every matching scoped candidate.
This avoids turning rare terms into account-wide posting probes. It is a bounded
cardinality heuristic, not a guarantee of optimal plans for every distribution.
Unscoped common-prefix aggregation remains potentially expensive.

Downloaded summary caching has transactional account/folder revisions separate
from UI invalidation. Membership, unread, starred, attachments, ordering and
thread/snooze dependencies invalidate only matching predicates/scopes. Resolved
physical scope and normalized SQL predicates identify the cache; folder remaps
and primary-folder changes therefore change the key. Cosmetic account/folder
updates, body bookkeeping and cursor progress do not invalidate counts. Snooze
deadlines are account scoped. Transactions may reuse matching committed summaries
and stage new summaries privately, publishing them only after durable commit;
rollback discards them, preventing speculative revision reuse. Count-only consumers
omit MIN; list pages share a combined exact count/oldest summary across pages.
Gmail reuses matching committed/staged counts inside its existing synchronous
content/cursor transaction, without removing or delaying any commit. IMAP only counts unread
locally when the provider has not supplied it.

Account-wide Unread/Starred pages have partial indexes ordered by
`(account_id, list_sort_ts DESC, id DESC)`, including folder/thread predicate
metadata. A held read row is a disjoint id lookup merged with indexed unread
branches, not an OR predicate that prevents the partial-index path. Required
existing indexes remain. Index creation is an ordinary durable migration;
building the added indexes has storage and write costs.

Unfiltered list IPC optionally accepts `pageCursor` with version, tuple boundary
and offset. Its version binds resolved scope, exact summary revisions/order and
the next snooze deadline. Valid boundaries use `(list_sort_ts,id) < (?,?)` and
zero SQL OFFSET. Each merged mailbox admits at most the requested page size.
Whole-scope count/oldest queries never include the boundary. Invalid, stale,
malformed or wrong-scope cursors fall back to the requested numeric offset and
return `cursorReset`. This is a local navigation hint, not authorization.
`nextCursor` is null for filtered pages or the last cached page. Existing offset,
pageToken and exact geometry fields remain compatible. The renderer keeps at most
32 boundaries, resets on scope changes/refresh and uses offset fallback for Back
when a boundary is unavailable. It never accumulates message pages. Filtered
keyset paging, reverse seeks and arbitrary deep offset optimization are deferred.

## Durability and limits

No startup-copy, body backfill, cold search repair, journal, fsync, checkpoint
publication or acknowledgement changes. Astra R07 is deferred: its synthetic
dispatch/size evidence does not establish safe runtime byte/age thresholds or
physical I/O behavior on target hardware. Changing shared checkpoint cadence
also needs coordination with the separate startup optimization job and recovery,
ENOSPC, retry and process-exit evidence. Runtime checkpoint policy stays as-is.

## Validation

`scripts/check-runtime-10k.js` uses isolated synthetic stores, real SQLite and
production handlers with providers blocked. It checks 11,101 rows, wide-body
search projection and original-query ranking parity, scoped count-only badges,
snooze expiry and journal rollback, partial-index and tuple query plans, exact
merged paging with duplicate timestamps, stale/wrong-scope fallback, bounded
renderer Previous/Next history, rendered help, integrity and durable reopen.
Existing performance/storage, unread, search and persistence suites complement
it. Native Electron query plans and Mac/Windows foreground frame/I/O timings
remain unverified; these changes do not claim constant-time search/filter work.
